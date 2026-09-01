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

func TestValidateSymbol(t *testing.T) {
	valid := []string{
		"MTNGH", "GCB", "EGL", "A", "SOGEGHRT4",
		// Preference shares, rights issues and one hyphenated historical
		// listing. All are real GSE tickers present in the price history.
		"SCB PREF", "CAL PREF", "GGBL RE", "ALW RE", "SG-SSB",
	}
	for _, s := range valid {
		if !validateSymbol(s) {
			t.Errorf("validateSymbol(%q) = false, want true", s)
		}
	}

	invalid := []string{
		"", " ", "-", "123", "1MTN", "mtngh", "MTN;DROP", "MTN'--",
		" SCB", "SCB ", "SCB  PREF", "SCB--SSB", "SCB-", "-SCB",
		"ABCDEFGHIJKLMNOPQ", // longer than symbolMaxLen
	}
	for _, s := range invalid {
		if validateSymbol(s) {
			t.Errorf("validateSymbol(%q) = true, want false", s)
		}
	}
}
