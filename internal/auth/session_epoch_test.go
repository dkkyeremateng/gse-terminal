package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeSessionStore is an in-memory stand-in for the Redis repo, satisfying
// both TokenRevoker and RefreshTokenStore so the middleware can run without
// a live Redis.
type fakeSessionStore struct {
	revoked  map[string]bool
	epochs   map[int]int
	refresh  map[string]refreshRecord
	locked   map[int]bool
	epochErr error
}

type refreshRecord struct {
	userID   int
	username string
	role     string
	epoch    int
}

func newFakeStore() *fakeSessionStore {
	return &fakeSessionStore{
		revoked: map[string]bool{},
		epochs:  map[int]int{},
		refresh: map[string]refreshRecord{},
		locked:  map[int]bool{},
	}
}

func (f *fakeSessionStore) Revoke(_ context.Context, jti string, _ time.Duration) error {
	f.revoked[jti] = true
	return nil
}
func (f *fakeSessionStore) IsRevoked(_ context.Context, jti string) (bool, error) {
	return f.revoked[jti], nil
}
func (f *fakeSessionStore) CheckSession(_ context.Context, jti string, userID int) (bool, int, error) {
	if f.epochErr != nil {
		return false, 0, f.epochErr
	}
	return f.revoked[jti], f.epochs[userID], nil
}
func (f *fakeSessionStore) SessionEpoch(_ context.Context, userID int) (int, error) {
	if f.epochErr != nil {
		return 0, f.epochErr
	}
	return f.epochs[userID], nil
}
func (f *fakeSessionStore) StoreRefreshToken(_ context.Context, token string, userID int, username, role string, epoch int, _ time.Duration) error {
	f.refresh[token] = refreshRecord{userID, username, role, epoch}
	return nil
}
func (f *fakeSessionStore) LookupRefreshToken(_ context.Context, token string) (int, string, string, int, error) {
	rec, ok := f.refresh[token]
	if !ok {
		return 0, "", "", 0, errors.New("not found")
	}
	return rec.userID, rec.username, rec.role, rec.epoch, nil
}
func (f *fakeSessionStore) TouchRefreshToken(context.Context, string, time.Duration) error {
	return nil
}
func (f *fakeSessionStore) DeleteRefreshToken(_ context.Context, token string) error {
	delete(f.refresh, token)
	return nil
}
func (f *fakeSessionStore) IsUserLocked(_ context.Context, userID int) (bool, error) {
	return f.locked[userID], nil
}

// newTestService wires an AuthService against the fake store.
func newTestService(store *fakeSessionStore) *AuthService {
	svc := NewAuthService("test-secret-at-least-32-chars-long!!", false)
	svc.SetTokenRevoker(store)
	svc.SetRefreshTokenStore(store)
	return svc
}

// roleSeenBy runs a request through Middleware and reports the role the
// downstream handler observed. Empty means the request fell through as a
// guest.
func roleSeenBy(svc *AuthService, req *http.Request) string {
	var seen string
	h := svc.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen, _ = r.Context().Value(RoleKey).(string)
	}))
	h.ServeHTTP(httptest.NewRecorder(), req)
	return seen
}

// A demoted admin must not keep admin on the JWT they are already holding.
// Before the session epoch existed, this token stayed valid — and therefore
// stayed admin — for its full 24h TTL.
func TestMiddleware_BumpedEpochRejectsLiveToken(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store)

	tok, err := svc.GenerateToken(7, "alice", "admin", 0)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	req := httptest.NewRequest("GET", "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if got := roleSeenBy(svc, req); got != "admin" {
		t.Fatalf("before demotion: role = %q, want admin", got)
	}

	// Admin demotes user 7. UpdateUserRole bumps the epoch.
	store.epochs[7] = 1

	req2 := httptest.NewRequest("GET", "/v1/me", nil)
	req2.Header.Set("Authorization", "Bearer "+tok)
	if got := roleSeenBy(svc, req2); got != "" {
		t.Errorf("after demotion: role = %q, want the token refused (guest)", got)
	}
}

// The refresh cookie is the other half: even once the access JWT expires,
// silent refresh would mint a fresh one from the role cached at login.
func TestSilentRefresh_BumpedEpochRefusesRefreshCookie(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store)

	rec := httptest.NewRecorder()
	if err := svc.IssueRefresh(context.Background(), rec, 7, "alice", "admin", 0); err != nil {
		t.Fatalf("IssueRefresh: %v", err)
	}
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == RefreshCookieName {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no refresh cookie issued")
	}

	// Sanity: with a matching epoch the refresh works and returns admin.
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(cookie)
	claims, err := svc.silentRefresh(httptest.NewRecorder(), req)
	if err != nil {
		t.Fatalf("silentRefresh before demotion: %v", err)
	}
	if claims["role"] != "admin" {
		t.Fatalf("role = %v, want admin", claims["role"])
	}

	// Demote, then try again with the same cookie.
	store.epochs[7] = 1
	req2 := httptest.NewRequest("GET", "/", nil)
	req2.AddCookie(cookie)
	if _, err := svc.silentRefresh(httptest.NewRecorder(), req2); err == nil {
		t.Error("silentRefresh succeeded after demotion; the stale role would have been reissued")
	}
	if _, still := store.refresh[cookie.Value]; still {
		t.Error("superseded refresh token was not deleted from the store")
	}
}

// A user who has never been demoted, locked, or deleted has no epoch key.
// Their tokens (including any minted before the sess claim existed) must
// keep working.
func TestMiddleware_UnbumpedUserUnaffected(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store)

	tok, _ := svc.GenerateToken(9, "bob", "pro", 0)
	req := httptest.NewRequest("GET", "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if got := roleSeenBy(svc, req); got != "pro" {
		t.Errorf("role = %q, want pro", got)
	}
}

// A Redis failure must not mint a session from a role we cannot verify.
func TestSilentRefresh_HardFailsWhenEpochUnavailable(t *testing.T) {
	store := newFakeStore()
	svc := newTestService(store)

	rec := httptest.NewRecorder()
	_ = svc.IssueRefresh(context.Background(), rec, 7, "alice", "admin", 0)
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == RefreshCookieName {
			cookie = c
		}
	}

	store.epochErr = errors.New("redis down")
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(cookie)
	if _, err := svc.silentRefresh(httptest.NewRecorder(), req); err == nil {
		t.Error("silentRefresh succeeded while the epoch was unreadable")
	}
}
