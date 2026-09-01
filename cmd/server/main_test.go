package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/httprate"
)

// /metrics exposes runtime internals and per-route latency, so the gate has
// to reject a missing, wrong, or malformed credential — and give a prober no
// signal that the endpoint exists.
func TestRequireBearerToken(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("go_goroutines 12"))
	})
	h := requireBearerToken("s3cret", next)

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"correct token", "Bearer s3cret", http.StatusOK},
		{"no header", "", http.StatusNotFound},
		{"wrong token", "Bearer nope", http.StatusNotFound},
		{"missing prefix", "s3cret", http.StatusNotFound},
		{"wrong scheme", "Basic s3cret", http.StatusNotFound},
		{"case-mangled prefix", "bearer s3cret", http.StatusNotFound},
		{"token as prefix of header", "Bearer s3cretXX", http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/metrics", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d", rec.Code, tc.want)
			}
			if tc.want != http.StatusOK && rec.Body.Len() > 0 &&
				rec.Body.String() == "go_goroutines 12" {
				t.Error("handler body leaked to an unauthorised caller")
			}
		})
	}
}

// keyByUser mirrors the router's keyByUserOrIP for a request that already
// carries an authenticated principal.
func keyByUser(uid int) httprate.KeyFunc {
	return func(*http.Request) (string, error) { return "user:" + strconv.Itoa(uid), nil }
}

func countAllowed(h http.Handler, req func(int) *http.Request, n int) (allowed, limited int) {
	for i := 0; i < n; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req(i))
		if rec.Code == http.StatusTooManyRequests {
			limited++
		} else {
			allowed++
		}
	}
	return allowed, limited
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
}

// POST /v1/me/merge-account bcrypt-verifies an arbitrary username+password.
// Unlimited, it is a password-guessing oracle running at whatever the global
// 300/min budget allows.
func TestCredentialLimiter_CapsGuessesPerUser(t *testing.T) {
	h := newCredentialLimiter(keyByUser(42))(okHandler())
	allowed, limited := countAllowed(h, func(int) *http.Request {
		r := httptest.NewRequest("POST", "/v1/me/merge-account", nil)
		r.RemoteAddr = "203.0.113.7:1234"
		return r
	}, 50)
	if allowed != credentialPerUserPerMin {
		t.Errorf("allowed = %d, want %d", allowed, credentialPerUserPerMin)
	}
	if limited == 0 {
		t.Error("no requests were limited")
	}
}

// Registering extra accounts must not buy extra guesses. Model the dodge
// directly: the attacker rotates user ids (a fresh per-user bucket each
// time, the best case for them) from one address. The shared per-IP
// limiter is what has to hold.
func TestCredentialLimiter_PerIPCeilingSurvivesAccountRotation(t *testing.T) {
	perIP := httprate.LimitByIP(credentialPerIPPerMin, 1*time.Minute)
	allowed, limited := 0, 0
	for attempt := 0; attempt < 100; attempt++ {
		// New user id per attempt => the per-user limiter never fires.
		h := perIP(newPerUserOnly(keyByUser(attempt))(okHandler()))
		rec := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/v1/me/merge-account", nil)
		r.RemoteAddr = "203.0.113.7:1234"
		h.ServeHTTP(rec, r)
		if rec.Code == http.StatusTooManyRequests {
			limited++
		} else {
			allowed++
		}
	}
	if allowed != credentialPerIPPerMin {
		t.Errorf("guesses allowed while rotating accounts from one IP = %d, want %d",
			allowed, credentialPerIPPerMin)
	}
	if limited == 0 {
		t.Error("account rotation was never limited")
	}
}

// newPerUserOnly is the inner half of newCredentialLimiter, used to prove
// the per-IP half carries the load when the per-user half is defeated.
func newPerUserOnly(keyFn httprate.KeyFunc) func(http.Handler) http.Handler {
	return httprate.Limit(credentialPerUserPerMin, 1*time.Minute, httprate.WithKeyFuncs(keyFn))
}

// The verification endpoint sends branded mail to a caller-supplied address.
func TestEmailSendLimiter_CapsOutgoingMail(t *testing.T) {
	h := newEmailSendLimiter(keyByUser(9))(okHandler())
	allowed, limited := countAllowed(h, func(int) *http.Request {
		r := httptest.NewRequest("POST", "/v1/me/email/request-verify", nil)
		r.RemoteAddr = "198.51.100.4:9999"
		return r
	}, 30)
	if allowed != emailSendPerUserPerHour {
		t.Errorf("allowed = %d, want %d", allowed, emailSendPerUserPerHour)
	}
	if limited == 0 {
		t.Error("no requests were limited")
	}
}

// Independent users must not share a bucket.
func TestCredentialLimiter_SeparatesUsers(t *testing.T) {
	for _, uid := range []int{1, 2} {
		h := newCredentialLimiter(keyByUser(uid))(okHandler())
		allowed, _ := countAllowed(h, func(int) *http.Request {
			r := httptest.NewRequest("POST", "/v1/me/password", nil)
			r.RemoteAddr = "192.0.2." + strconv.Itoa(uid) + ":1000"
			return r
		}, 10)
		if allowed != credentialPerUserPerMin {
			t.Errorf("user %d allowed = %d, want %d", uid, allowed, credentialPerUserPerMin)
		}
	}
}
