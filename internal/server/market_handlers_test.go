package server

import (
	"fmt"
	"mime"
	"strings"
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

// The export handler was the one symbol-taking endpoint that skipped
// validateSymbol, so an arbitrary path segment became a Redis key
// (gse:data:ticks:<anything>, cached 6h) and a QuestDB scan.
func TestValidateSymbol_GuardsExportInput(t *testing.T) {
	rejected := []string{
		"../../etc/passwd",
		"A:B",                   // ':' would nest inside the gse:data: namespace
		strings.Repeat("A", 64), // unbounded key length
		"a b c d e f g h i j k", // lowercase + oversized
		"",
		" ",
		"-LEAD",
		"TRAIL-",
		"DOUBLE  SPACE",
	}
	for _, sym := range rejected {
		if validateSymbol(sym) {
			t.Errorf("validateSymbol(%q) = true, want rejected", sym)
		}
	}

	// The separator-bearing tickers that actually exist must keep working —
	// rejecting them once cost 4,458 rows of real history.
	for _, sym := range []string{"MTNGH", "GCB", "SCB PREF", "CAL PREF", "GGBL RE", "SG-SSB"} {
		if !validateSymbol(sym) {
			t.Errorf("validateSymbol(%q) = false, want accepted", sym)
		}
	}
}

// Several real tickers contain a space. An unquoted Content-Disposition
// filename parameter ends at the first space, so "SCB PREF" downloaded as
// a file called "SCB".
func TestExportFilenameIsQuoted(t *testing.T) {
	filename := "SCB PREF_historical_data_2026-09-01.csv"
	header := fmt.Sprintf("attachment; filename=%q", filename)

	_, params, err := mime.ParseMediaType(header)
	if err != nil {
		t.Fatalf("ParseMediaType(%q): %v", header, err)
	}
	if params["filename"] != filename {
		t.Errorf("filename = %q, want %q", params["filename"], filename)
	}

	// Show the old form really did truncate, so this test is guarding
	// something rather than restating the obvious.
	_, oldParams, err := mime.ParseMediaType(fmt.Sprintf("attachment; filename=%s", filename))
	if err == nil && oldParams["filename"] == filename {
		t.Error("unquoted form round-tripped intact; the quoting fix would be pointless")
	}
}
