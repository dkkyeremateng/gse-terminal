package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
