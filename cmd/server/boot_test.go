package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func fastBackoff(t *testing.T) {
	t.Helper()
	saved := connectBackoff
	connectBackoff.initial, connectBackoff.max = time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { connectBackoff = saved })
}

// The reboot race: the dependency refuses the first few dials, then comes up.
// Boot must ride that out rather than giving up on the first refusal.
func TestConnectWithRetry_SucceedsOnceDependencyComesUp(t *testing.T) {
	fastBackoff(t)
	calls := 0
	v, err := connectWithRetry(context.Background(), "dep", time.Second, func(context.Context) (string, error) {
		calls++
		if calls < 3 {
			return "", errors.New("connection refused")
		}
		return "ok", nil
	})
	if err != nil || v != "ok" {
		t.Fatalf("got (%q, %v), want (\"ok\", nil)", v, err)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
}

// A dependency that never answers must fail the boot within the window, with
// the underlying cause preserved — never hand back a zero value as success.
func TestConnectWithRetry_GivesUpAfterWindow(t *testing.T) {
	fastBackoff(t)
	cause := errors.New("connection refused")
	start := time.Now()
	v, err := connectWithRetry(context.Background(), "dep", 50*time.Millisecond, func(context.Context) (*int, error) {
		return nil, cause
	})
	if err == nil {
		t.Fatal("expected an error after the window elapsed")
	}
	if !errors.Is(err, cause) {
		t.Errorf("error %v does not wrap the last connect error", err)
	}
	if v != nil {
		t.Errorf("value = %v, want nil on failure", v)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("took %v, window was 50ms", elapsed)
	}
}
