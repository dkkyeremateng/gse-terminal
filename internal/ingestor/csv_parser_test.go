package ingestor

import (
	"testing"
)

// parseRecord and the helpers are pure functions on []string + headerMap so
// they can be tested without standing up QuestDB. These tests pin the
// expected behaviour of the CSV column normalisation and the float/int
// cleaning helpers.

func TestNormalizeHeader(t *testing.T) {
	cases := map[string]string{
		"Daily Date":           "dailydate",
		"Share Code":           "sharecode",
		"Closing Price (VWAP)": "closingpricevwap",
		"":                     "",
	}
	for in, want := range cases {
		if got := normalizeHeader(in); got != want {
			t.Errorf("normalizeHeader(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseRecord_HappyPath(t *testing.T) {
	headers := []string{"Daily Date", "Share Code", "Opening Price", "Last Transaction Price", "Total Shares Traded"}
	headerMap := map[string]int{}
	for i, h := range headers {
		headerMap[normalizeHeader(h)] = i
	}
	rec := []string{"05/03/2026", "MTNGH", "1.50", "1.62", "1,234,567"}
	tick, err := parseRecord(rec, headerMap)
	if err != nil {
		t.Fatalf("parseRecord: %v", err)
	}
	if tick.Symbol != "MTNGH" {
		t.Errorf("symbol = %q, want MTNGH", tick.Symbol)
	}
	if tick.OpenPrice != 1.50 {
		t.Errorf("open = %v, want 1.50", tick.OpenPrice)
	}
	if tick.LastPrice != 1.62 {
		t.Errorf("last = %v, want 1.62", tick.LastPrice)
	}
	if tick.TotalVolume != 1234567 {
		t.Errorf("volume = %d, want 1234567", tick.TotalVolume)
	}
	if tick.TradingDate.Day() != 5 || tick.TradingDate.Month() != 3 {
		t.Errorf("date = %v, want 5 March", tick.TradingDate)
	}
}

func TestParseRecord_RejectsMissingDate(t *testing.T) {
	headers := []string{"Share Code"}
	headerMap := map[string]int{normalizeHeader(headers[0]): 0}
	if _, err := parseRecord([]string{"MTNGH"}, headerMap); err == nil {
		t.Error("expected error for missing date column")
	}
}

func TestParseRecord_RejectsMissingSymbol(t *testing.T) {
	headers := []string{"Daily Date"}
	headerMap := map[string]int{normalizeHeader(headers[0]): 0}
	if _, err := parseRecord([]string{"05/03/2026"}, headerMap); err == nil {
		t.Error("expected error for missing symbol column")
	}
}

func TestParseRecord_BadDate(t *testing.T) {
	headers := []string{"Daily Date", "Share Code"}
	headerMap := map[string]int{normalizeHeader(headers[0]): 0, normalizeHeader(headers[1]): 1}
	if _, err := parseRecord([]string{"not-a-date", "MTNGH"}, headerMap); err == nil {
		t.Error("expected error for malformed date")
	}
}

func TestParseFloatClean(t *testing.T) {
	cases := map[string]float64{
		"1.23":    1.23,
		"1,234.5": 1234.5,
		" 0.50 ":  0.50,
		"":        0,
		"abc":     0,
	}
	for in, want := range cases {
		if got := parseFloatClean(in); got != want {
			t.Errorf("parseFloatClean(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestParseIntClean(t *testing.T) {
	cases := map[string]int64{
		"1234":      1234,
		"1,234,567": 1234567,
		"":          0,
		"abc":       0,
	}
	for in, want := range cases {
		if got := parseIntClean(in); got != want {
			t.Errorf("parseIntClean(%q) = %d, want %d", in, got, want)
		}
	}
}
