package server

import (
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestIsBriefingEmptyResult(t *testing.T) {
	if !isBriefingEmptyResult(pgx.ErrNoRows) {
		t.Fatalf("expected pgx.ErrNoRows to be treated as empty briefing")
	}
}

func TestEmptyBriefingPayload(t *testing.T) {
	payload := emptyBriefingPayload()

	if _, ok := payload["summary"]; !ok {
		t.Fatalf("payload missing summary key")
	}
	if payload["summary"] != nil {
		t.Fatalf("summary = %v, want nil", payload["summary"])
	}

	insights, ok := payload["insights"].([]any)
	if !ok {
		t.Fatalf("insights has unexpected type: %T", payload["insights"])
	}
	if len(insights) != 0 {
		t.Fatalf("insights length = %d, want 0", len(insights))
	}
}
