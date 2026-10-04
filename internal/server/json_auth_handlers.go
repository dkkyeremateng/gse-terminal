package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/teckdroids/ges-data-engine/internal/audit"
	"github.com/teckdroids/ges-data-engine/internal/auth"
	"golang.org/x/crypto/bcrypt"
)

// The JSON counterparts to the form-encoded /login, /signup and /logout
// handlers in auth_handlers.go. Those three answer with a 302 redirect or a
// plain-text body because their only caller is the HTMX terminal in ui/; the
// React client under /v2 needs a status code and a JSON envelope it can act
// on without following a redirect into a page it doesn't own.
//
// The credential checking, audit logging and cookie issuance are shared with
// the legacy handlers (checkCredentials / createAccount below) so the two
// surfaces can't drift on anything that matters — the timing-equalised
// bcrypt compare, the lock-after-password ordering, the username validation,
// or the session + refresh cookie pair.

// credentialCheck is the outcome of verifying a submitted username/password.
type credentialCheck int

const (
	credentialsInvalid credentialCheck = iota
	credentialsLocked
	credentialsValid
)

// checkCredentials verifies a username/password pair and records the audit
// entry for the attempt. It deliberately reveals nothing through timing: an
// unknown username is compared against decoyHash so both paths spend a full
// bcrypt round, and a locked account is only reported after the password has
// already checked out.
//
// Callers get (0, "") for anything but credentialsValid/credentialsLocked.
func (s *Server) checkCredentials(ctx context.Context, username, password string) (int, string, credentialCheck) {
	userID, hash, role, isLocked, lookupErr := s.pgRepo.GetUserByUsername(ctx, username)

	compareAgainst := []byte(hash)
	if lookupErr != nil {
		compareAgainst = decoyHash
	}
	passwordOK := bcrypt.CompareHashAndPassword(compareAgainst, []byte(password)) == nil

	if lookupErr != nil || !passwordOK {
		// Only log a failure for an account that exists — an audit entry
		// for every typo'd username turns the log into a dictionary of
		// what an attacker guessed, and tells us nothing.
		if lookupErr == nil {
			s.auditLog.Log(ctx, audit.ActionLoginFailure, "Auth", "Login", map[string]interface{}{
				"username": username,
				"role":     role,
			})
		}
		return 0, "", credentialsInvalid
	}

	if isLocked {
		return userID, role, credentialsLocked
	}

	s.auditLog.Log(ctx, audit.ActionLoginSuccess, "Auth", "Login", map[string]interface{}{
		"username": username,
		"role":     role,
	})
	return userID, role, credentialsValid
}

// authError carries a failure from the shared signup path back to whichever
// handler invoked it, so each can render it in its own format rather than
// writing a response from inside the shared code.
type authError struct {
	status  int
	message string
}

// createAccount validates the pair, creates the user, and issues the session
// cookies (signup auto-logs-in). On success it returns nil and the response
// carries a valid session; on failure nothing but cookies-untouched state has
// changed and the caller renders the error.
func (s *Server) createAccount(w http.ResponseWriter, r *http.Request, username, password string) *authError {
	if username == "" || password == "" {
		return &authError{http.StatusBadRequest, "Username and password required"}
	}
	// Reject Unicode lookalikes ("аdmin" with Cyrillic а), control chars,
	// and mixed-case impersonation handles up-front. Without this an
	// attacker could register a visually identical username and use it
	// in social-engineering against admins.
	if err := auth.ValidateUsername(username); err != nil {
		return &authError{http.StatusBadRequest, err.Error()}
	}
	if err := auth.ValidatePassword(password); err != nil {
		return &authError{http.StatusBadRequest, err.Error()}
	}

	if _, _, _, _, err := s.pgRepo.GetUserByUsername(r.Context(), username); err == nil {
		return &authError{http.StatusConflict, "Username already exists"}
	}

	if err := s.pgRepo.CreateUser(r.Context(), username, password, "user"); err != nil {
		return &authError{http.StatusInternalServerError, "Could not create user"}
	}

	userID, _, role, _, err := s.pgRepo.GetUserByUsername(r.Context(), username)
	if err != nil {
		return &authError{http.StatusInternalServerError, "Signup successful, but login failed"}
	}
	if err := s.issueSessionCookie(w, r, userID, username, role); err != nil {
		return &authError{http.StatusInternalServerError, "Error generating token"}
	}
	return nil
}

// maxCredentialBody caps the JSON body these endpoints will read. Credentials
// are two short strings; anything larger is a mistake or an attempt to make
// the decoder allocate.
const maxCredentialBody = 4 << 10 // 4 KiB

type credentialsRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// decodeCredentials reads and normalises a {username, password} body. It
// returns false and writes the error response when the body is unusable.
func decodeCredentials(w http.ResponseWriter, r *http.Request) (credentialsRequest, bool) {
	var req credentialsRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, maxCredentialBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON body")
		return req, false
	}
	req.Username = auth.NormalizeUsername(req.Username)
	return req, true
}

// HandleAPILogin is POST /v1/auth/login — the JSON login used by the /v2
// client. Success sets the same session + refresh cookies as the form login
// and answers 200 with the caller's identity, so the client doesn't need a
// follow-up /v1/me round trip to render the shell.
func (s *Server) HandleAPILogin(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeCredentials(w, r)
	if !ok {
		return
	}

	userID, role, result := s.checkCredentials(r.Context(), req.Username, req.Password)
	switch result {
	case credentialsInvalid:
		respondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	case credentialsLocked:
		respondError(w, http.StatusForbidden, "Account access suspended. Contact administrator.")
		return
	}

	if err := s.issueSessionCookie(w, r, userID, req.Username, role); err != nil {
		respondError(w, http.StatusInternalServerError, "Error generating token")
		return
	}
	respondJSON(w, map[string]interface{}{
		"isAuthenticated": true,
		"username":        req.Username,
		"role":            role,
		"isAdmin":         role == "admin",
	})
}

// HandleAPISignup is POST /v1/auth/signup. Like the form handler it
// auto-logs-in on success, so the client lands on an authenticated session
// without a second request.
func (s *Server) HandleAPISignup(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeCredentials(w, r)
	if !ok {
		return
	}

	if aerr := s.createAccount(w, r, req.Username, req.Password); aerr != nil {
		respondError(w, aerr.status, aerr.message)
		return
	}
	respondJSON(w, map[string]interface{}{
		"isAuthenticated": true,
		"username":        req.Username,
		"role":            "user",
		"isAdmin":         false,
	})
}

// HandleAPILogout is POST /v1/auth/logout. Same revocation work as the form
// logout — JWT jti blacklisted, refresh token dropped from Redis, both
// cookies cleared — but it answers 200 with JSON instead of redirecting to
// the legacy /login page, which would drop a /v2 user out of the SPA.
func (s *Server) HandleAPILogout(w http.ResponseWriter, r *http.Request) {
	s.revokeSession(w, r)
	respondJSON(w, map[string]interface{}{"isAuthenticated": false})
}

// HandleAPIRefresh is POST /v1/auth/refresh. It carries no logic of its own:
// the route is mounted behind authSvc.Middleware, which already performs the
// silent refresh (expired access token + valid refresh cookie ⇒ new cookies
// written to this very response). The handler just reports whether that
// produced a session, so the client can distinguish "renewed, replay your
// request" from "genuinely signed out".
func (s *Server) HandleAPIRefresh(w http.ResponseWriter, r *http.Request) {
	username, _ := r.Context().Value(auth.UsernameKey).(string)
	if username == "" {
		respondError(w, http.StatusUnauthorized, "Session expired")
		return
	}
	role, _ := r.Context().Value(auth.RoleKey).(string)
	respondJSON(w, map[string]interface{}{
		"isAuthenticated": true,
		"username":        username,
		"role":            role,
		"isAdmin":         role == "admin",
	})
}
