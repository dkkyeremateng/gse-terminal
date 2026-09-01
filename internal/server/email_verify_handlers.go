package server

import (
	"context"
	"encoding/json"
	"fmt"
	htmlpkg "html"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/audit"
	"github.com/teckdroids/ges-data-engine/internal/auth"
)

// emailDispatcher is the narrow outgoing-mail interface the server
// package needs — matches the signature of email.Sender from
// internal/email without importing the concrete type here. Kept local
// so the server package can accept either the real SMTP sender or a
// noop, without depending on internal/email directly.
type emailDispatcher interface {
	Send(ctx context.Context, to, subject, htmlBody, plainBody string) error
}

// SetEmailSender wires the outgoing-mail dispatcher. Optional — when nil
// the email-gated flows still record the request (audit log + DB) but
// skip the outgoing send.
func (s *Server) SetEmailSender(d emailDispatcher) { s.emailSender = d }

// ─── Email verification ────────────────────────────────────────────────────
//
// Two-step flow:
//   1. POST /v1/me/email/request-verify  → caller submits an email; server
//      stores it (email_verified=FALSE), generates a 24h token, sends the
//      link to the new address.
//   2. GET  /auth/verify-email?token=…   → consume the token, flip the
//      flag, redirect to /terminal with a success flag so the UI can toast.
//
// Used by the alerts gate: Pro users without a verified email are offered
// two options (link OAuth or add-email-manually). This handler backs the
// manual path.

type requestVerifyReq struct {
	Email string `json:"email"`
}

// HandleRequestEmailVerification stores the proposed email on the caller's
// user row and emails a verification link to it. Idempotent-ish: submitting
// again invalidates any outstanding token and issues a fresh one (the repo
// method handles that atomically).
func (s *Server) HandleRequestEmailVerification(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	defer r.Body.Close()
	var req requestVerifyReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	email := strings.TrimSpace(strings.ToLower(req.Email))
	// Server-side validation: reject empty, length-check, RFC 5322 parse.
	if email == "" {
		respondError(w, http.StatusBadRequest, "email required")
		return
	}
	if len(email) > 254 { // RFC limit
		respondError(w, http.StatusBadRequest, "email too long")
		return
	}
	if _, err := mail.ParseAddress(email); err != nil {
		respondError(w, http.StatusBadRequest, "invalid email address")
		return
	}

	// Refuse if the user has an OAuth provider linked — those emails are
	// provider-managed; a manual change here would be overwritten by the
	// next OAuth sign-in. The user must unlink the provider first via
	// /v1/me/unlink-provider before changing email manually.
	if provider, _, _, err := s.pgRepo.GetUserProvider(r.Context(), user.ID); err == nil && provider != "" {
		respondError(w, http.StatusConflict,
			"your email is managed by your linked provider — unlink the provider before setting a different email")
		return
	}

	// Guard against grabbing an email that belongs to another account.
	// The unique partial index on users.email enforces this at the DB
	// level, but catching it here gives a clean 409 instead of a 500.
	if takenID, _, _, _, err := s.pgRepo.GetUserByEmail(r.Context(), email); err == nil && takenID != 0 && takenID != user.ID {
		respondError(w, http.StatusConflict, "this email is already linked to another account")
		return
	}

	token, err := s.pgRepo.StartEmailVerification(r.Context(), user.ID, email)
	if err != nil {
		LoggerFromCtx(r.Context()).Error("email verification start failed", "user_id", user.ID, "error", err)
		respondError(w, http.StatusInternalServerError, "failed to start verification")
		return
	}

	// Send the verification email in a tracked background goroutine so a
	// stalled SMTP relay can't hold the HTTP response. The handler returns
	// 202 immediately — the user sees "check your inbox" either way.
	if s.emailSender != nil {
		s.goBackground(func(bgCtx context.Context) {
			sctx, cancel := context.WithTimeout(bgCtx, 20*time.Second)
			defer cancel()
			subject, html, plain := renderVerifyEmail(email, token, s.cfg.ResolvedAppBaseURL())
			if err := s.emailSender.Send(sctx, email, subject, html, plain); err != nil {
				LoggerFromCtx(bgCtx).Warn("verify email send failed", "user_id", user.ID, "error", err)
			}
		})
	}

	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), audit.ActionUserStatus, "email_verify_request", email, map[string]interface{}{
			"user_id": user.ID,
		})
	}

	w.WriteHeader(http.StatusAccepted)
	respondJSON(w, map[string]string{"status": "sent", "email": email})
}

// HandleVerifyEmail is the target of the link in the verification email.
// Consumes the token, flips email_verified, and redirects to /terminal
// with a query flag the frontend toasts on. Renders inline HTML on
// failure so the user isn't dumped at the terminal with a silent error.
func (s *Server) HandleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		respondVerifyError(w, "Missing verification token.")
		return
	}
	// Tokens are hex(32 bytes) = 64 chars. Reject anything wildly off so
	// we don't round-trip obvious junk to the DB.
	if len(token) < 32 || len(token) > 128 {
		respondVerifyError(w, "Malformed verification token.")
		return
	}

	userID, email, err := s.pgRepo.ConsumeEmailVerifyToken(r.Context(), token)
	if err != nil {
		// Real error goes to server logs; user sees a generic message so we
		// don't leak DB internals (e.g. "duplicate key", SQL syntax) into the
		// HTML response and the user's browser history.
		LoggerFromCtx(r.Context()).Info("email verification rejected", "error", err)
		respondVerifyError(w, "The verification link is invalid, expired, or has already been used.")
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), audit.ActionUserStatus, "email_verified", email, map[string]interface{}{
			"user_id": userID,
		})
	}

	// Redirect into the terminal with a flag the frontend toasts on.
	http.Redirect(w, r, "/terminal?email_verified=1", http.StatusFound)
}

// respondVerifyError renders a brand-aligned inline HTML page for failed
// verification attempts. Kept inline (no template) because there's exactly
// one failure page and the server package already carries no template
// engine for HTML responses.
func respondVerifyError(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusBadRequest)
	fmt.Fprintf(w, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Verification failed</title><style>
body{background:#0b0a08;color:#f4ecd8;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;}
.card{max-width:420px;background:#100e0a;border:1px solid rgba(244,236,216,0.22);padding:32px;}
.kicker{font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.24em;color:#b23a17;margin-bottom:18px;}
h1{font-family:Georgia,serif;font-size:22px;margin:0 0 8px;}
p{color:rgba(244,236,216,0.7);font-size:14px;line-height:1.5;margin:0 0 20px;}
a{display:inline-block;background:#ffb12b;color:#0b0a08;padding:10px 18px;text-decoration:none;font-family:'Courier New',monospace;font-size:11px;font-weight:bold;letter-spacing:0.2em;text-transform:uppercase;}
</style></head><body><div class="card">
<div class="kicker">Verification Failed</div>
<h1>We couldn't verify that link.</h1>
<p>%s</p>
<a href="/terminal">Back to the terminal</a>
</div></body></html>`, htmlpkg.EscapeString(msg))
}

// renderVerifyEmail produces the subject + HTML + plaintext of the
// verification email. Same brand language as the alert-fire email in
// internal/alerts/alerts.go — amber on ink, JetBrains Mono for the
// kicker, Georgia for the heading.
func renderVerifyEmail(toEmail, token, baseURL string) (subject, html, plain string) {
	verifyLink := fmt.Sprintf("%s/auth/verify-email?token=%s",
		strings.TrimRight(baseURL, "/"), token)

	subject = "Verify your email for GSE Terminal alerts"

	html = fmt.Sprintf(`<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#0b0a08;color:#f4ecd8;padding:24px;margin:0;">
<div style="max-width:520px;margin:0 auto;background:#100e0a;border:1px solid rgba(244,236,216,0.22);padding:28px;">
<div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.24em;color:#ffb12b;margin-bottom:16px;">GSE TERMINAL · EMAIL VERIFICATION</div>
<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 12px 0;color:#f4ecd8;">Confirm your email</h1>
<p style="color:rgba(244,236,216,0.7);margin:0 0 20px 0;font-size:13px;line-height:1.5;">
You asked to use <strong style="color:#f4ecd8;">%s</strong> for watchlist alert notifications. Click the button below to confirm this address. The link expires in 24 hours.
</p>
<p style="margin:0 0 20px 0;"><a href="%s" style="display:inline-block;background:#ffb12b;color:#0b0a08;padding:12px 24px;text-decoration:none;font-family:'Courier New',monospace;font-size:11px;font-weight:bold;letter-spacing:0.2em;text-transform:uppercase;">Confirm email →</a></p>
<p style="color:rgba(244,236,216,0.4);font-size:11px;line-height:1.6;margin-top:24px;">
If the button doesn't work, paste this link into your browser:<br>
<span style="font-family:'Courier New',monospace;word-break:break-all;">%s</span>
</p>
<p style="color:rgba(244,236,216,0.4);font-size:11px;margin-top:16px;">Didn't request this? You can ignore this email — no changes have been made to your account.</p>
</div></body></html>`,
		htmlpkg.EscapeString(toEmail), verifyLink, verifyLink,
	)

	plain = fmt.Sprintf(`GSE TERMINAL — CONFIRM YOUR EMAIL

You asked to use %s for watchlist alert notifications.
Click the link below to confirm this address. Expires in 24 hours.

%s

Didn't request this? You can ignore this email — no changes have been made.`,
		toEmail, verifyLink,
	)
	return subject, html, plain
}
