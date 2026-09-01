package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const UserIDKey contextKey = "userID"
const UsernameKey contextKey = "username"
const RoleKey contextKey = "role"

// AccessTokenTTL is the maximum lifetime of a session JWT.
//
// 24 hours caps exposure if a token leaks (device theft, shared
// workstation, a successful XSS). The middleware's silent-refresh
// path (see Middleware below) swaps an expired access token for a
// fresh one using the refresh cookie, so 24h doesn't translate to
// "user is logged out every 24h" in practice.
const AccessTokenTTL = 24 * time.Hour

// RefreshTokenTTL is the lifetime of a refresh token in Redis. Long
// enough that users who visit the site at least once a season stay
// logged in indefinitely (the TTL slides forward every silent
// refresh). Users truly idle for 90 days are logged out.
const RefreshTokenTTL = 90 * 24 * time.Hour

// RefreshCookieName is the HttpOnly cookie that carries an opaque
// 32-byte token looked up in Redis. Path=/ so the middleware sees it
// on every request (silent refresh is cross-path).
const RefreshCookieName = "refresh_token"

// APIKeyResolver is the narrow interface AuthService needs to validate
// incoming API keys. The PostgresRepo satisfies it; it lives in this file
// so the auth package doesn't import the repository package directly.
type APIKeyResolver interface {
	LookupAPIKey(ctx context.Context, keyHash string) (keyID, userID int, username, role string, isLocked bool, err error)
	TouchAPIKey(ctx context.Context, keyID int)
}

// TokenRevoker checks / records JWT revocation by jti. Implemented by the
// Redis repo so the hot path stays a single network round-trip. Defining
// the interface here keeps auth free of a hard import on repository.
type TokenRevoker interface {
	Revoke(ctx context.Context, jti string, ttl time.Duration) error
	IsRevoked(ctx context.Context, jti string) (bool, error)
	// CheckSession answers both per-request questions in one round
	// trip: is this jti revoked, and what is the user's current session
	// epoch. Middleware compares the returned epoch against the token's
	// own `sess` claim and refuses anything stale, which is what makes
	// a role change or a deletion take effect on an already-issued JWT
	// rather than 24 hours later.
	CheckSession(ctx context.Context, jti string, userID int) (revoked bool, epoch int, err error)
}

// RefreshTokenStore persists long-lived refresh tokens out-of-band of
// the access JWT so they can be revoked on logout and slid forward on
// every use. Implementation is the Redis repo; Store writes with the
// cookie TTL, Lookup returns the session identity bound to the token,
// Touch resets the TTL (sliding expiry), and Delete invalidates on
// logout.
//
// Username + role are cached in the store itself so silent-refresh on
// an expired JWT is a single Redis GET — no DB round-trip on every
// request from an idle user after a 24h gap. The cached role would go
// stale after an admin demotes someone, so every stored token also
// carries the session epoch it was issued under; BumpSessionEpoch on
// the admin side invalidates all of them at once. See sessionEpochKey
// in the Redis repo.
type RefreshTokenStore interface {
	StoreRefreshToken(ctx context.Context, token string, userID int, username, role string, epoch int, ttl time.Duration) error
	LookupRefreshToken(ctx context.Context, token string) (userID int, username, role string, epoch int, err error)
	// SessionEpoch reads the user's current epoch so newly issued
	// credentials can be stamped with it.
	SessionEpoch(ctx context.Context, userID int) (int, error)
	TouchRefreshToken(ctx context.Context, token string, ttl time.Duration) error
	DeleteRefreshToken(ctx context.Context, token string) error
	// IsUserLocked reports whether an admin has locked the user mid-
	// session. Checked on every silent refresh so locked users can't
	// keep extending their JWTs indefinitely. Soft-fail (false, err) on
	// Redis errors — the surrounding code treats false-with-error as
	// "not locked" so a transient outage doesn't sign every user out.
	IsUserLocked(ctx context.Context, userID int) (bool, error)
}

// BackgroundRunner schedules a fire-and-forget goroutine bound to a
// server-lifetime context that Shutdown can drain. The server package
// injects its `goBackground` method via SetBackgroundRunner so the auth
// package stays decoupled from server internals. If no runner is set,
// Middleware falls back to an untracked goroutine (pre-hardening
// behaviour) with a 2s timeout.
type BackgroundRunner func(fn func(ctx context.Context))

type AuthService struct {
	secretKey     string
	apiKeys       APIKeyResolver
	revoker       TokenRevoker
	refreshStore  RefreshTokenStore
	runBackground BackgroundRunner
	SecureCookies bool // true in production (HTTPS); false in dev (HTTP)
}

func NewAuthService(secretKey string, secureCookies bool) *AuthService {
	return &AuthService{secretKey: secretKey, SecureCookies: secureCookies}
}

// SetAPIKeyResolver wires the API key store after construction. Optional —
// if not set, only JWT auth is supported.
func (s *AuthService) SetAPIKeyResolver(r APIKeyResolver) {
	s.apiKeys = r
}

// SetTokenRevoker wires the JWT revocation store. Optional — if unset,
// logout is best-effort (cookie clear only).
func (s *AuthService) SetTokenRevoker(r TokenRevoker) {
	s.revoker = r
}

// SetRefreshTokenStore wires the refresh-token persistence. Without
// it, Middleware skips the silent-refresh path on expired JWTs and
// falls back to guest — matching pre-refresh behaviour.
func (s *AuthService) SetRefreshTokenStore(r RefreshTokenStore) {
	s.refreshStore = r
}

// RefreshTokenStore exposes the wired store so handlers (login, logout)
// can issue / invalidate refresh tokens alongside their own cookie work.
// Returns nil when the refresh flow is disabled.
func (s *AuthService) RefreshTokenStore() RefreshTokenStore { return s.refreshStore }

// SetBackgroundRunner wires a tracked goroutine launcher (typically
// server.goBackground) so TouchAPIKey runs under the server's WaitGroup
// and is awaited during Shutdown. Optional.
func (s *AuthService) SetBackgroundRunner(r BackgroundRunner) {
	s.runBackground = r
}

// Revoker returns the configured revoker so handlers can record an explicit
// logout. Returns nil if revocation is not wired up.
func (s *AuthService) Revoker() TokenRevoker { return s.revoker }

// newJTI returns a 16-byte hex token id used as the JWT's `jti` claim.
// Returns an error on entropy failure so the caller can respond with
// HTTP 500 without crashing the entire server.
func newJTI() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("entropy failure generating jti: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// newRefreshToken returns a 32-byte hex opaque refresh token. Double
// the jti width because refresh tokens live 90× longer than access
// tokens and are the sole credential on silent refresh.
func newRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("entropy failure generating refresh token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// IssueRefresh creates a new refresh token, stores it in the backing
// Redis store alongside the session identity (username, role), and
// sets the HttpOnly cookie on the response. Identity is stashed so
// silent refresh on expired JWTs can rebuild the session in one
// Redis GET — no DB round-trip per request from idle users.
// No-ops when the refresh store isn't wired (tests / bare instances).
func (s *AuthService) IssueRefresh(ctx context.Context, w http.ResponseWriter, userID int, username, role string, epoch int) error {
	if s.refreshStore == nil {
		return nil
	}
	tok, err := newRefreshToken()
	if err != nil {
		return err
	}
	if err := s.refreshStore.StoreRefreshToken(ctx, tok, userID, username, role, epoch, RefreshTokenTTL); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     RefreshCookieName,
		Value:    tok,
		Path:     "/",
		Expires:  time.Now().Add(RefreshTokenTTL),
		HttpOnly: true,
		Secure:   s.SecureCookies,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// SessionEpoch returns the user's current session epoch, or 0 when the
// refresh store isn't wired or Redis is unreachable. Soft-failing to 0
// keeps a Redis blip from blocking logins; the resulting session is
// stamped epoch 0 and will be refused on its next request once Redis
// recovers and reports the real (non-zero) epoch — a forced re-login,
// not an unauthorised session.
func (s *AuthService) SessionEpoch(ctx context.Context, userID int) int {
	if s.refreshStore == nil {
		return 0
	}
	epoch, err := s.refreshStore.SessionEpoch(ctx, userID)
	if err != nil {
		return 0
	}
	return epoch
}

// ClearRefresh invalidates the refresh token (if present) in the store
// and clears the cookie on the response. Used by /logout; the
// middleware's silent-refresh path also calls it when the stored token
// is missing / for a locked user.
func (s *AuthService) ClearRefresh(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(RefreshCookieName); err == nil && c.Value != "" && s.refreshStore != nil {
		_ = s.refreshStore.DeleteRefreshToken(ctx, c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name: RefreshCookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.SecureCookies, SameSite: http.SameSiteLaxMode,
	})
}

// ctxFromClaims copies JWT claims into a request context under the
// UserIDKey / UsernameKey / RoleKey keys so downstream handlers can
// read the caller identity. Shared between the primary JWT path and
// the silent-refresh path so the context shape is identical either
// way.
func ctxFromClaims(parent context.Context, claims jwt.MapClaims) context.Context {
	ctx := parent
	if userID, ok := claims["user_id"].(float64); ok {
		ctx = context.WithValue(ctx, UserIDKey, int(userID))
	}
	if username, ok := claims["username"].(string); ok {
		ctx = context.WithValue(ctx, UsernameKey, username)
	}
	if role, ok := claims["role"].(string); ok {
		ctx = context.WithValue(ctx, RoleKey, role)
	}
	return ctx
}

// clearSessionCookie clears just the access cookie. Shared by
// Middleware (stale JWT) and by ClearRefresh callers that want both
// cookies gone.
func (s *AuthService) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: "session", Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.SecureCookies, SameSite: http.SameSiteLaxMode,
	})
}

// silentRefresh trades an expired access-token for a fresh one using
// the refresh cookie. Returns the new JWT claims (to populate request
// context) or an error if refresh is unavailable. On success it also
// writes the new `session` cookie and slides the refresh TTL back to
// RefreshTokenTTL so active users never rebuild their session from
// scratch.
//
// Pure Redis path — username + role were stashed at IssueRefresh time
// so a single GET rebuilds the session. Role/lock changes therefore
// take effect on next explicit login (which rotates the refresh
// value); admins who need immediate server-wide lockout should call
// DeleteRefreshToken for the user's tokens alongside the lock action.
//
// Does not rotate the refresh token itself: with concurrent requests
// (dashboard fires many fetches at once on page load), rotation would
// race — the first refresh invalidates the token, the rest fail and
// log the user out. Non-rotating keeps refresh idempotent under
// concurrency at the cost of extending a stolen token's useful life
// to its natural 90d TTL.
func (s *AuthService) silentRefresh(w http.ResponseWriter, r *http.Request) (jwt.MapClaims, error) {
	if s.refreshStore == nil {
		return nil, fmt.Errorf("refresh not configured")
	}
	cookie, err := r.Cookie(RefreshCookieName)
	if err != nil || cookie.Value == "" {
		return nil, fmt.Errorf("no refresh cookie")
	}
	userID, username, role, tokenEpoch, err := s.refreshStore.LookupRefreshToken(r.Context(), cookie.Value)
	if err != nil || userID == 0 {
		return nil, fmt.Errorf("refresh token not found")
	}
	if username == "" {
		// Legacy refresh token from the pre-identity-stash format —
		// force a re-login rather than issuing an un-identified
		// session. The 90d TTL means these age out naturally; no
		// need to rescue them with a DB fallback that we're trying
		// to avoid in the first place.
		_ = s.refreshStore.DeleteRefreshToken(r.Context(), cookie.Value)
		return nil, fmt.Errorf("refresh token missing identity")
	}
	// Mid-session lock check. Without this, an admin clicking "Lock"
	// only takes effect after the user's current 24h JWT expires AND
	// they've been offline long enough that they don't have an active
	// session — the silent-refresh path would otherwise rebuild a fresh
	// 24h JWT from the unrevoked refresh cookie, keeping the locked
	// user signed in indefinitely. Soft-fail on Redis errors (treat as
	// not-locked) so a transient outage doesn't kick every user out.
	if locked, _ := s.refreshStore.IsUserLocked(r.Context(), userID); locked {
		_ = s.refreshStore.DeleteRefreshToken(r.Context(), cookie.Value)
		return nil, fmt.Errorf("user locked")
	}
	// Epoch check. The username + role in this record were cached at
	// login; if an admin has since changed the user's role or deleted
	// the account, that cache is a lie and minting a JWT from it would
	// hand back the stale privileges. Bumping the epoch is what the
	// admin paths do, and it lands here.
	//
	// Hard-fail on a Redis error (unlike the lock check above): we
	// cannot confirm the cached role is still valid, and the cost of
	// being wrong is an unauthorised privilege level, not an
	// inconvenience. The user still has their password.
	currentEpoch, epochErr := s.refreshStore.SessionEpoch(r.Context(), userID)
	if epochErr != nil {
		return nil, fmt.Errorf("session epoch unavailable: %w", epochErr)
	}
	if tokenEpoch != currentEpoch {
		_ = s.refreshStore.DeleteRefreshToken(r.Context(), cookie.Value)
		return nil, fmt.Errorf("session superseded")
	}
	tokenStr, err := s.GenerateToken(userID, username, role, currentEpoch)
	if err != nil {
		return nil, err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    tokenStr,
		Path:     "/",
		Expires:  time.Now().Add(AccessTokenTTL),
		HttpOnly: true,
		Secure:   s.SecureCookies,
		SameSite: http.SameSiteLaxMode,
	})
	// Sliding expiry — every successful silent refresh bumps the
	// refresh token's TTL back to the full 90d. Soft-fail: a Redis
	// blip shouldn't fail the whole refresh.
	_ = s.refreshStore.TouchRefreshToken(r.Context(), cookie.Value, RefreshTokenTTL)
	claims, err := s.ParseToken(tokenStr)
	if err != nil {
		return nil, err
	}
	return claims, nil
}

// GenerateToken issues a fresh JWT bound to a unique jti so the token can
// be individually revoked on logout.
func (s *AuthService) GenerateToken(userID int, username, role string, epoch int) (string, error) {
	jti, err := newJTI()
	if err != nil {
		return "", err
	}
	now := time.Now()
	claims := jwt.MapClaims{
		"user_id":  userID,
		"username": username,
		"role":     role,
		"jti":      jti,
		"iat":      now.Unix(),
		"exp":      now.Add(AccessTokenTTL).Unix(),
		// sess pins the token to the session epoch current at issue
		// time. Middleware refuses the token once the stored epoch
		// moves past it, so an admin demoting or deleting a user takes
		// effect on their next request rather than when the JWT
		// happens to expire.
		"sess": epoch,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(s.secretKey))
}

// ParseToken parses and validates a JWT token.
func (s *AuthService) ParseToken(tokenString string) (jwt.MapClaims, error) {
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(s.secretKey), nil
	})

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(jwt.MapClaims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}

// Middleware verifies the request principal from any of three sources:
//  1. `Authorization: Bearer ges_live_...` — API key (validated against the
//     api_keys table; supports machine clients)
//  2. `Authorization: Bearer <jwt>` — JWT
//  3. `session` cookie — JWT (used by browser sessions)
//
// Guests fall through with no user context set.
func (s *AuthService) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var tokenStr string

		authHeader := r.Header.Get("Authorization")
		if authHeader != "" && strings.HasPrefix(authHeader, "Bearer ") {
			tokenStr = strings.TrimPrefix(authHeader, "Bearer ")
		}
		if tokenStr == "" {
			if cookie, err := r.Cookie("session"); err == nil {
				tokenStr = cookie.Value
			}
		}

		if tokenStr == "" {
			// No access token. Normal after 24h — browser drops the
			// session cookie at its Expires. Fall through to the
			// refresh path if a refresh cookie is present so the
			// user stays logged in without a manual re-auth.
			if claims, rErr := s.silentRefresh(w, r); rErr == nil {
				ctx := ctxFromClaims(r.Context(), claims)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			// No refresh cookie, or refresh failed — clear any stray
			// refresh cookie so the browser doesn't keep retrying a
			// dead token on every request.
			if _, err := r.Cookie(RefreshCookieName); err == nil {
				s.ClearRefresh(r.Context(), w, r)
			}
			next.ServeHTTP(w, r)
			return
		}

		// Branch on token shape — API keys are validated by hash lookup,
		// everything else is parsed as a JWT.
		if LooksLikeAPIKey(tokenStr) {
			if s.apiKeys == nil {
				http.Error(w, "API keys not enabled", http.StatusUnauthorized)
				return
			}
			hash := HashAPIKey(tokenStr)
			keyID, userID, username, role, isLocked, err := s.apiKeys.LookupAPIKey(r.Context(), hash)
			if err != nil || isLocked {
				http.Error(w, "Invalid API key", http.StatusUnauthorized)
				return
			}
			// Refresh last_used_at off the request context with a hard 2s
			// timeout. Preferred path: server-tracked goroutine (drained on
			// Shutdown); fallback: untracked fire-and-forget bounded only by
			// the 2s ceiling. The runner is nil in tests that construct
			// AuthService directly without wiring the server.
			touch := func(parent context.Context, id int) {
				cctx, cancel := context.WithTimeout(parent, 2*time.Second)
				defer cancel()
				s.apiKeys.TouchAPIKey(cctx, id)
			}
			if s.runBackground != nil {
				id := keyID
				s.runBackground(func(bgCtx context.Context) { touch(bgCtx, id) })
			} else {
				go touch(context.Background(), keyID)
			}

			ctx := r.Context()
			ctx = context.WithValue(ctx, UserIDKey, userID)
			ctx = context.WithValue(ctx, UsernameKey, username)
			ctx = context.WithValue(ctx, RoleKey, role)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		claims, err := s.ParseToken(tokenStr)
		if err != nil {
			// Expired access token: try the silent-refresh path.
			// A valid refresh cookie rebuilds the session in-flight
			// so the user never sees "logged out" from 24h expiry.
			if errors.Is(err, jwt.ErrTokenExpired) {
				if refreshed, rErr := s.silentRefresh(w, r); rErr == nil {
					claims = refreshed
					goto populateContext
				}
				// Refresh failed — drop both cookies so the refresh
				// cookie doesn't linger and retrigger on every
				// request.
				s.ClearRefresh(r.Context(), w, r)
			}
			// Stale/invalid cookie — clear it and continue as a guest.
			// Redirecting here would lock guests out of public pages
			// like / and /terminal whenever an old session cookie was
			// left over from a previous build or expired token.
			s.clearSessionCookie(w)
			next.ServeHTTP(w, r)
			return
		}
	populateContext:

		// Revocation + epoch check (logout, role change, lock, delete),
		// fused into one Redis round trip. Soft-fail on Redis errors so a
		// blip doesn't sign everyone out — the same trade the revocation
		// check has always made. A stale epoch drops the caller to guest
		// rather than 401ing, matching how an invalid cookie is handled
		// below: public pages keep working, and anything gated bounces
		// through the normal login redirect.
		if s.revoker != nil {
			jti, _ := claims["jti"].(string)
			uid, _ := claims["user_id"].(float64)
			if jti != "" {
				revoked, currentEpoch, err := s.revoker.CheckSession(r.Context(), jti, int(uid))
				// A token minted before the `sess` claim existed reads as
				// epoch 0, which matches any user who has never been
				// demoted, locked, or deleted. Anyone who has will have a
				// non-zero epoch, so those tokens are refused — which is
				// the intended upgrade path.
				tokenEpoch, _ := claims["sess"].(float64)
				if err == nil && (revoked || int(tokenEpoch) != currentEpoch) {
					s.clearSessionCookie(w)
					next.ServeHTTP(w, r)
					return
				}
			}
		}

		next.ServeHTTP(w, r.WithContext(ctxFromClaims(r.Context(), claims)))
	})
}

// RequireAuth ensures the user is authenticated.
func (s *AuthService) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, _ := r.Context().Value(UsernameKey).(string)
		if username == "" {
			if strings.HasPrefix(r.URL.Path, "/v1/") {
				http.Error(w, "Authentication required", http.StatusUnauthorized)
				return
			}
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AdminMiddleware ensures the user is authenticated AND is an admin.
func (s *AuthService) AdminMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, _ := r.Context().Value(RoleKey).(string)
		if role != "admin" {
			username, _ := r.Context().Value(UsernameKey).(string)

			if strings.HasPrefix(r.URL.Path, "/v1/") {
				http.Error(w, "Admin access required", http.StatusForbidden)
				return
			}

			if username != "" {
				http.Redirect(w, r, "/terminal", http.StatusFound)
			} else {
				http.Redirect(w, r, "/login", http.StatusFound)
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireProOrAdmin ensures the user is authenticated AND is either an
// admin or a pro user.
func (s *AuthService) RequireProOrAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, _ := r.Context().Value(RoleKey).(string)
		if role != "admin" && role != "pro" {
			if strings.HasPrefix(r.URL.Path, "/v1/") {
				http.Error(w, "Pro or Admin access required", http.StatusForbidden)
				return
			}
			http.Redirect(w, r, "/terminal", http.StatusFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}
