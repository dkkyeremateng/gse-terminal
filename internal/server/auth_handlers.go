package server

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/teckdroids/ges-data-engine/internal/audit"
	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/repository"
	"golang.org/x/crypto/bcrypt"
)

func (s *Server) HandleMe(w http.ResponseWriter, r *http.Request) {
	username, _ := r.Context().Value(auth.UsernameKey).(string)
	role, _ := r.Context().Value(auth.RoleKey).(string)
	userID, _ := r.Context().Value(auth.UserIDKey).(int)

	resp := map[string]interface{}{
		"isAuthenticated": username != "",
		"username":        username,
		"isAdmin":         role == "admin",
		"role":            role,
	}

	// Include provider info and available providers for authenticated users
	if userID > 0 {
		provider, _, email, err := s.pgRepo.GetUserProvider(r.Context(), userID)
		if err == nil {
			resp["provider"] = provider
			resp["providerEmail"] = email
		}
		if hasPw, pwErr := s.pgRepo.HasPassword(r.Context(), userID); pwErr == nil {
			resp["hasPassword"] = hasPw
		}
		// Expose email + email_verified so the frontend can route users
		// without a verified address into the "connect email" panel
		// before they hit the alert-create 403. The email returned here
		// is the definitive users.email column (may equal providerEmail
		// for OAuth users, or be a manually-entered address).
		if userEmail, verified, err := s.pgRepo.GetUserEmailInfo(r.Context(), userID); err == nil {
			resp["email"] = userEmail
			resp["emailVerified"] = verified
		}
		available := make([]map[string]string, 0, len(s.oauthProviders))
		for _, p := range s.oauthProviders {
			available = append(available, map[string]string{
				"name":        p.Name(),
				"displayName": p.DisplayName(),
			})
		}
		resp["availableProviders"] = available
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Server) HandleLoginPost(w http.ResponseWriter, r *http.Request) {
	username := auth.NormalizeUsername(r.FormValue("username"))
	password := r.FormValue("password")

	userID, hash, role, isLocked, err := s.pgRepo.GetUserByUsername(r.Context(), username)
	if err != nil {
		if r.Header.Get("HX-Request") == "true" {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusUnauthorized)
		}
		fmt.Fprintf(w, "Invalid credentials")
		return
	}

	if isLocked {
		if r.Header.Get("HX-Request") == "true" {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusForbidden)
		}
		fmt.Fprintf(w, "Account access suspended. Contact administrator.")
		return
	}

	err = bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	if err != nil {
		s.auditLog.Log(r.Context(), audit.ActionLoginFailure, "Auth", "Login", map[string]interface{}{
			"username": username,
			"role":     role,
		})
		if r.Header.Get("HX-Request") == "true" {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusUnauthorized)
		}
		fmt.Fprintf(w, "Invalid credentials")
		return
	}
	s.auditLog.Log(r.Context(), audit.ActionLoginSuccess, "Auth", "Login", map[string]interface{}{
		"username": username,
		"role":     role,
	})

	if err := s.issueSessionCookie(w, r, userID, username, role); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "Error generating token")
		return
	}

	if r.Header.Get("HX-Request") == "true" {
		w.Header().Set("HX-Redirect", "/terminal")
		w.WriteHeader(http.StatusOK)
	} else {
		http.Redirect(w, r, "/terminal", http.StatusFound)
	}
}

func (s *Server) HandleSignupPost(w http.ResponseWriter, r *http.Request) {
	username := auth.NormalizeUsername(r.FormValue("username"))
	password := r.FormValue("password")

	if username == "" || password == "" {
		if r.Header.Get("HX-Request") == "true" {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusBadRequest)
		}
		fmt.Fprintf(w, "Username and password required")
		return
	}
	// Reject Unicode lookalikes ("аdmin" with Cyrillic а), control chars,
	// and mixed-case impersonation handles up-front. Without this an
	// attacker could register a visually identical username and use it
	// in social-engineering against admins.
	if err := auth.ValidateUsername(username); err != nil {
		if r.Header.Get("HX-Request") == "true" {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusBadRequest)
		}
		fmt.Fprint(w, err.Error())
		return
	}
	if err := auth.ValidatePassword(password); err != nil {
		if r.Header.Get("HX-Request") == "true" {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusBadRequest)
		}
		fmt.Fprint(w, err.Error())
		return
	}

	// Check if user exists already
	_, _, _, _, err := s.pgRepo.GetUserByUsername(r.Context(), username)
	if err == nil {
		if r.Header.Get("HX-Request") == "true" {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusConflict)
		}
		fmt.Fprintf(w, "Username already exists")
		return
	}

	err = s.pgRepo.CreateUser(r.Context(), username, password, "user")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "Could not create user")
		return
	}

	// Auto-login after signup
	userID, _, role, _, err := s.pgRepo.GetUserByUsername(r.Context(), username)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "Signup successful, but login failed")
		return
	}

	if err := s.issueSessionCookie(w, r, userID, username, role); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "Error generating token")
		return
	}

	if r.Header.Get("HX-Request") == "true" {
		w.Header().Set("HX-Redirect", "/terminal")
		w.WriteHeader(http.StatusOK)
	} else {
		http.Redirect(w, r, "/terminal", http.StatusFound)
	}
}

// issueSessionCookie generates a JWT for the given user and sets it as a
// session cookie. Also issues a 90-day refresh cookie so the middleware
// can silently renew the access token when it expires — users visiting
// at least once every 90 days never see a login screen. Shared by
// email/password login, signup, and Google OAuth.
func (s *Server) issueSessionCookie(w http.ResponseWriter, r *http.Request, userID int, username, role string) error {
	token, err := s.authSvc.GenerateToken(userID, username, role)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		Expires:  time.Now().Add(auth.AccessTokenTTL),
		HttpOnly: true,
		Secure:   s.secureCookie(),
		SameSite: http.SameSiteLaxMode,
	})
	// Issue the refresh cookie. Soft-fail: if Redis is down the
	// session still works for 24h, we just can't silently renew after
	// that.
	if err := s.authSvc.IssueRefresh(r.Context(), w, userID, username, role); err != nil {
		LoggerFromCtx(r.Context()).Warn("[auth] refresh issue failed", "error", err, "user_id", userID)
	}
	return nil
}

// ── OAuth Handlers (provider-agnostic) ────────────────────────────────

// HandleOAuthLogin initiates the OAuth flow for a given provider.
// The provider name is extracted from the URL: /auth/{provider}/login
func (s *Server) HandleOAuthLogin(w http.ResponseWriter, r *http.Request) {
	providerName := chi.URLParam(r, "provider")
	provider := s.OAuthProvider(providerName)
	if provider == nil {
		http.NotFound(w, r)
		return
	}

	state, err := auth.GenerateState()
	if err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	// Encode provider in state cookie: "provider:randomstate"
	cookieVal := providerName + ":" + state
	http.SetCookie(w, &http.Cookie{
		Name:     "oauth_state",
		Value:    cookieVal,
		Path:     "/",
		MaxAge:   600,
		HttpOnly: true,
		Secure:   s.secureCookie(),
		SameSite: http.SameSiteLaxMode,
	})

	http.Redirect(w, r, provider.AuthCodeURL(cookieVal), http.StatusFound)
}

// HandleOAuthCallback handles the redirect from the OAuth provider.
// State cookie format: "provider:state" (login) or "link:provider:state" (linking).
func (s *Server) HandleOAuthCallback(w http.ResponseWriter, r *http.Request) {
	// 1. Validate CSRF state
	stateCookie, err := r.Cookie("oauth_state")
	if err != nil || stateCookie.Value == "" {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: "oauth_state", Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.secureCookie(), SameSite: http.SameSiteLaxMode,
	})

	queryState := r.URL.Query().Get("state")
	if subtle.ConstantTimeCompare([]byte(stateCookie.Value), []byte(queryState)) != 1 {
		LoggerFromCtx(r.Context()).Warn("[oauth] state mismatch")
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	// 2. Parse state to extract mode and provider
	// Format: "provider:state" (login, exactly 2 parts) or
	//         "link:provider:state" (link, exactly 3 parts).
	// Strict arity per branch — the previous len >= 2 / len >= 3 check
	// would let a malformed "link:foo" land in the link branch with an
	// empty (or missing) state segment. Defensive: an attacker can't
	// forge the cookie (HttpOnly + constant-time match), but a parser
	// that quietly accepts malformed input is the kind of thing that
	// rots into a real bug after a future schema change.
	isLink := false
	parts := strings.SplitN(stateCookie.Value, ":", 3)
	var providerName string
	switch {
	case len(parts) == 3 && parts[0] == "link" && parts[1] != "" && parts[2] != "":
		isLink = true
		providerName = parts[1]
	case len(parts) == 2 && parts[0] != "" && parts[1] != "":
		providerName = parts[0]
	default:
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	provider := s.OAuthProvider(providerName)
	if provider == nil {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	// 3. Check for user-denied error
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		LoggerFromCtx(r.Context()).Info("[oauth] user denied consent", "error", errParam, "provider", providerName)
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	// 4. Exchange code for tokens
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	token, err := provider.Exchange(r.Context(), code)
	if err != nil {
		LoggerFromCtx(r.Context()).Error("[oauth] code exchange failed", "error", err, "provider", providerName)
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	// 5. Fetch user info
	oauthUser, err := provider.FetchUser(r.Context(), token)
	if err != nil {
		LoggerFromCtx(r.Context()).Error("[oauth] fetch user failed", "error", err, "provider", providerName)
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	if !oauthUser.EmailVerified {
		LoggerFromCtx(r.Context()).Warn("[oauth] unverified email rejected", "email", oauthUser.Email, "provider", providerName)
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	// 6. Branch: linking vs login/create
	if isLink {
		s.handleOAuthLinkCallback(w, r, providerName, oauthUser)
		return
	}

	// 7. Find or create user
	var userID int
	var username, role string
	var isLocked bool

	// 7a. Returning user — lookup by provider + provider_id
	userID, username, role, isLocked, err = s.pgRepo.GetUserByProviderID(r.Context(), providerName, oauthUser.ProviderID)
	if err != nil {
		// 7b. Try email match. Only auto-link when the matching row is
		// eligible: no password, no provider already linked, AND the
		// stored email is verified. The atomic check inside
		// LinkProviderByEmailIfEligible closes the TOCTOU between the
		// eligibility read and the link write — a concurrent
		// SetPassword / LinkProvider can't slip in between.
		//
		// Specifically refuses auto-link to:
		//   - password-protected accounts (user explicitly chose
		//     password auth; takeover would bypass that)
		//   - accounts already linked to a different provider (an
		//     attacker who controls the same email at a *different*
		//     provider could otherwise claim the account)
		//   - accounts whose email isn't verified (the email could
		//     have been entered manually; "I claim foo@bar" via OAuth
		//     should not link to "I typed foo@bar" without proof)
		linkID, linkUsername, linkRole, linkLocked, linkErr := s.pgRepo.LinkProviderByEmailIfEligible(
			r.Context(), oauthUser.Email, providerName, oauthUser.ProviderID,
		)
		if linkErr == nil {
			userID, username, role, isLocked, err = linkID, linkUsername, linkRole, linkLocked, nil
			s.auditLog.Log(r.Context(), audit.ActionUserStatus, "Auth", "OAuthLink", map[string]interface{}{
				"user_id":  userID,
				"provider": providerName,
				"email":    oauthUser.Email,
			})
		} else if errors.Is(linkErr, repository.ErrAutoLinkIneligible) {
			// Email matches an existing user that we can't safely
			// auto-link onto. Refuse this OAuth login outright — the
			// legitimate account holder must log in via their existing
			// credentials and link explicitly via /auth/link/{provider}.
			LoggerFromCtx(r.Context()).Warn("[oauth] auto-link refused (ineligible row)", "email", oauthUser.Email, "provider", providerName)
			http.Redirect(w, r, "/login?oauth_error=link_existing_account", http.StatusFound)
			return
		}
	}

	if err != nil {
		// 7c. New user — derive username from email with collision retry.
		// SanitizeUsername coerces the email's local part into the
		// canonical lowercase ASCII charset so the derived handle can't
		// smuggle in Unicode lookalikes or punctuation that would break
		// later lookups (auth.ValidateUsername would reject them).
		derived := auth.SanitizeUsername(strings.SplitN(oauthUser.Email, "@", 2)[0])
		username = derived
		for i := 0; i < 10; i++ {
			if _, _, _, _, checkErr := s.pgRepo.GetUserByUsername(r.Context(), username); checkErr != nil {
				break
			}
			if i == 0 {
				username = auth.SanitizeUsername(derived + "_" + providerName[:1])
			} else {
				username = auth.SanitizeUsername(fmt.Sprintf("%s_%s%d", derived, providerName[:1], i))
			}
		}
		role = "user"
		if createErr := s.pgRepo.CreateOAuthUser(r.Context(), username, oauthUser.Email, providerName, oauthUser.ProviderID); createErr != nil {
			LoggerFromCtx(r.Context()).Error("[oauth] create user failed", "error", createErr, "email", oauthUser.Email, "provider", providerName)
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		userID, username, role, isLocked, err = s.pgRepo.GetUserByProviderID(r.Context(), providerName, oauthUser.ProviderID)
		if err != nil {
			LoggerFromCtx(r.Context()).Error("[oauth] fetch new user failed", "error", err)
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
	}

	if isLocked {
		LoggerFromCtx(r.Context()).Warn("[oauth] locked account login attempt", "user_id", userID, "provider", providerName)
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	s.auditLog.Log(r.Context(), audit.ActionLoginSuccess, "Auth", "OAuth", map[string]interface{}{
		"username": username,
		"role":     role,
		"provider": providerName,
		"email":    oauthUser.Email,
	})

	if err := s.issueSessionCookie(w, r, userID, username, role); err != nil {
		LoggerFromCtx(r.Context()).Error("[oauth] session cookie failed", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/terminal", http.StatusFound)
}

// ── Account Linking Handlers ──────────────────────────────────────────

// HandleGetLinkedProviders returns the user's linked provider and
// the list of all available providers for the frontend to render.
func (s *Server) HandleGetLinkedProviders(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(auth.UserIDKey).(int)
	provider, _, email, err := s.pgRepo.GetUserProvider(r.Context(), userID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch provider info")
		return
	}

	available := make([]map[string]string, 0, len(s.oauthProviders))
	for _, p := range s.oauthProviders {
		available = append(available, map[string]string{
			"name":        p.Name(),
			"displayName": p.DisplayName(),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"linkedProvider": provider,
		"linkedEmail":    email,
		"available":      available,
	})
}

// HandleLinkProvider initiates the OAuth linking flow for any configured
// provider. The provider name is extracted from the URL: /auth/link/{provider}
func (s *Server) HandleLinkProvider(w http.ResponseWriter, r *http.Request) {
	providerName := chi.URLParam(r, "provider")
	provider := s.OAuthProvider(providerName)
	if provider == nil {
		http.NotFound(w, r)
		return
	}

	username, _ := r.Context().Value(auth.UsernameKey).(string)
	if username == "" {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	state, err := auth.GenerateState()
	if err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	// State format: "link:provider:randomstate"
	cookieVal := "link:" + providerName + ":" + state
	http.SetCookie(w, &http.Cookie{
		Name:     "oauth_state",
		Value:    cookieVal,
		Path:     "/",
		MaxAge:   600,
		HttpOnly: true,
		Secure:   s.secureCookie(),
		SameSite: http.SameSiteLaxMode,
	})

	http.Redirect(w, r, provider.AuthCodeURL(cookieVal), http.StatusFound)
}

// handleOAuthLinkCallback links an OAuth identity to the current
// authenticated user. Called from HandleOAuthCallback when state is link-prefixed.
func (s *Server) handleOAuthLinkCallback(w http.ResponseWriter, r *http.Request, providerName string, oauthUser *auth.OAuthUser) {
	userID, _ := r.Context().Value(auth.UserIDKey).(int)
	username, _ := r.Context().Value(auth.UsernameKey).(string)
	if userID == 0 {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}

	// Check if this provider account is already linked to another user
	existingID, _, _, _, err := s.pgRepo.GetUserByProviderID(r.Context(), providerName, oauthUser.ProviderID)
	if err == nil && existingID != userID {
		LoggerFromCtx(r.Context()).Warn("[oauth] provider account already linked to another user", "provider", providerName, "existing_user", existingID)
		http.Redirect(w, r, "/terminal?oauth_error=account_taken", http.StatusFound)
		return
	}

	// Check if this email is already linked to another user
	emailOwnerID, _, _, _, emailErr := s.pgRepo.GetUserByEmail(r.Context(), oauthUser.Email)
	if emailErr == nil && emailOwnerID != userID {
		LoggerFromCtx(r.Context()).Warn("[oauth] email already linked to another account", "email", oauthUser.Email, "existing_user", emailOwnerID)
		http.Redirect(w, r, "/terminal?oauth_error=email_taken", http.StatusFound)
		return
	}

	// Check if current user already has this provider linked
	currentProvider, _, _, _ := s.pgRepo.GetUserProvider(r.Context(), userID)
	if currentProvider == providerName {
		http.Redirect(w, r, "/terminal?oauth_error=already_linked", http.StatusFound)
		return
	}

	if err := s.pgRepo.LinkProviderID(r.Context(), userID, providerName, oauthUser.ProviderID, oauthUser.Email); err != nil {
		LoggerFromCtx(r.Context()).Error("[oauth] link provider failed", "error", err, "user_id", userID, "provider", providerName)
		http.Redirect(w, r, "/terminal", http.StatusFound)
		return
	}

	s.auditLog.Log(r.Context(), audit.ActionUserStatus, "Auth", "OAuthLink", map[string]interface{}{
		"user_id":  userID,
		"username": username,
		"provider": providerName,
		"email":    oauthUser.Email,
	})

	http.Redirect(w, r, "/terminal", http.StatusFound)
}

// HandleUnlinkProvider removes the OAuth provider from the current user.
// If the user has no password, returns needs_password so the frontend
// can prompt them to set one before unlinking.
func (s *Server) HandleUnlinkProvider(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(auth.UserIDKey).(int)

	hasPassword, err := s.pgRepo.HasPassword(r.Context(), userID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to check account")
		return
	}
	if !hasPassword {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"status": "needs_password"})
		return
	}

	if err := s.pgRepo.UnlinkProvider(r.Context(), userID); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to unlink provider")
		return
	}

	username, _ := r.Context().Value(auth.UsernameKey).(string)
	s.auditLog.Log(r.Context(), audit.ActionUserStatus, "Auth", "OAuthUnlink", map[string]interface{}{
		"user_id":  userID,
		"username": username,
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "unlinked"})
}

// HandleSetPassword allows an OAuth-only user to set a password so they
// can later unlink their provider without losing access.
func (s *Server) HandleSetPassword(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(auth.UserIDKey).(int)
	password := r.FormValue("password")

	if err := auth.ValidatePassword(password); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	if err := s.pgRepo.UpdateUserPassword(r.Context(), userID, password); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to set password")
		return
	}

	username, _ := r.Context().Value(auth.UsernameKey).(string)
	s.auditLog.Log(r.Context(), audit.ActionUserStatus, "Auth", "PasswordSet", map[string]interface{}{
		"user_id":  userID,
		"username": username,
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "password_set"})
}

// HandleMergeAccount allows an OAuth-authenticated user to link their OAuth
// identity to an existing password-protected account by providing the target
// account's username and password. The current OAuth-only account is deleted
// and the user is re-issued a session as the target account.
func (s *Server) HandleMergeAccount(w http.ResponseWriter, r *http.Request) {
	currentUserID, _ := r.Context().Value(auth.UserIDKey).(int)
	if currentUserID == 0 {
		respondError(w, http.StatusUnauthorized, "Authentication required")
		return
	}

	// Only allow merge if the current account has a provider linked
	currentProvider, _, _, err := s.pgRepo.GetUserProvider(r.Context(), currentUserID)
	if err != nil || currentProvider == "" {
		respondError(w, http.StatusBadRequest, "No OAuth provider linked to current account")
		return
	}

	username := r.FormValue("username")
	password := r.FormValue("password")
	if username == "" || password == "" {
		respondError(w, http.StatusBadRequest, "Username and password required")
		return
	}

	// Verify the target account credentials
	targetUserID, hash, targetRole, isLocked, err := s.pgRepo.GetUserByUsername(r.Context(), username)
	if err != nil {
		respondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}
	if isLocked {
		respondError(w, http.StatusForbidden, "Target account is locked")
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		respondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	// Don't merge into yourself
	if targetUserID == currentUserID {
		respondError(w, http.StatusBadRequest, "Cannot merge into the same account")
		return
	}

	// Check the target doesn't already have a provider linked
	targetProvider, _, _, _ := s.pgRepo.GetUserProvider(r.Context(), targetUserID)
	if targetProvider != "" {
		respondError(w, http.StatusConflict, "Target account already has a linked provider")
		return
	}

	// Transfer the OAuth identity and delete the orphaned account
	if err := s.pgRepo.TransferProvider(r.Context(), currentUserID, targetUserID); err != nil {
		LoggerFromCtx(r.Context()).Error("[oauth] merge account failed", "error", err, "from", currentUserID, "to", targetUserID)
		respondError(w, http.StatusInternalServerError, "Failed to merge accounts")
		return
	}

	s.auditLog.Log(r.Context(), audit.ActionUserStatus, "Auth", "OAuthMerge", map[string]interface{}{
		"from_user_id": currentUserID,
		"to_user_id":   targetUserID,
		"to_username":  username,
		"provider":     currentProvider,
	})

	// Re-issue session as the target account
	if err := s.issueSessionCookie(w, r, targetUserID, username, targetRole); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to issue session")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":   "merged",
		"username": username,
	})
}

func (s *Server) HandleLogout(w http.ResponseWriter, r *http.Request) {
	// Best-effort: parse the current session JWT and add its jti to the
	// revocation list so the cookie can't be replayed before its natural
	// expiry. Soft-fail on every step — logout must always succeed.
	//
	// Failures are logged loudly (Warn) so monitoring can surface a
	// stuck Redis: the previous silent swallow meant a flaky logout
	// could leave a stolen JWT replayable for up to 24h with no
	// telemetry. The refresh-cookie clear below uses the same Redis
	// connection, so a logout during a Redis outage is genuinely
	// best-effort — but at least we'll see it in the logs.
	if revoker := s.authSvc.Revoker(); revoker != nil {
		if cookie, err := r.Cookie("session"); err == nil && cookie.Value != "" {
			if claims, err := s.authSvc.ParseToken(cookie.Value); err == nil {
				jti, _ := claims["jti"].(string)
				expF, _ := claims["exp"].(float64)
				if jti != "" && expF > 0 {
					ttl := time.Until(time.Unix(int64(expF), 0))
					if err := revoker.Revoke(r.Context(), jti, ttl); err != nil {
						LoggerFromCtx(r.Context()).Warn("[logout] jwt revoke failed; token remains replayable until natural expiry",
							"error", err, "jti", jti, "ttl_remaining", ttl)
					}
				}
			}
		}
	}

	// Drop the refresh token from Redis and clear the cookie so the
	// silent-refresh path in Middleware can't rebuild a session after
	// the explicit logout.
	s.authSvc.ClearRefresh(r.Context(), w, r)

	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secureCookie(),
		SameSite: http.SameSiteLaxMode,
	})

	if r.Header.Get("HX-Request") == "true" {
		w.Header().Set("HX-Redirect", "/login")
		w.WriteHeader(http.StatusOK)
	} else {
		http.Redirect(w, r, "/login", http.StatusFound)
	}
}
