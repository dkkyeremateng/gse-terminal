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

func TestParseRecord_RejectsEmptySymbol(t *testing.T) {
	headers := []string{"Daily Date", "Share Code"}
	headerMap := map[string]int{
		normalizeHeader(headers[0]): 0,
		normalizeHeader(headers[1]): 1,
	}
	for _, sym := range []string{"", "   ", "**"} {
		if _, err := parseRecord([]string{"05/03/2026", sym}, headerMap); err == nil {
			t.Errorf("expected error for empty symbol %q", sym)
		}
	}
}

func TestParseRecord_StripsFootnoteMarkers(t *testing.T) {
	headers := []string{"Daily Date", "Share Code"}
	headerMap := map[string]int{
		normalizeHeader(headers[0]): 0,
		normalizeHeader(headers[1]): 1,
	}
	cases := map[string]string{
		"**ALW**":     "ALW",
		"PBC**":       "PBC",
		"**CALPREF**": "CALPREF",
		"ALW":         "ALW",
		// Rights issues are separate instruments and must survive
		// untouched. "SCB PREF" is no longer among them: it is an alias
		// of SCBPREF, the same security under the spelling the exchange
		// uses today — see TestParseRecord_FoldsAliasSpellings.
		"GGBL RE": "GGBL RE",
		"ALW RE":  "ALW RE",
	}
	for in, want := range cases {
		tick, err := parseRecord([]string{"05/03/2026", in}, headerMap)
		if err != nil {
			t.Errorf("parseRecord(%q) unexpected error: %v", in, err)
			continue
		}
		if tick.Symbol != want {
			t.Errorf("parseRecord(%q).Symbol = %q, want %q", in, tick.Symbol, want)
		}
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
		// GSE's historical exports carry four decimal places. Folding them
		// into the integer would multiply every volume by 10^4.
		"200.0000":     200,
		"3707400.0000": 3707400,
		"0.0000":       0,
		"1234.9":       1234,
		"1,234.0000":   1234,
	}
	for in, want := range cases {
		if got := parseIntClean(in); got != want {
			t.Errorf("parseIntClean(%q) = %d, want %d", in, got, want)
		}
	}
}

// The prefix list is a preference order. It used to be decorative: the
// loops were nested header-outside, so the first header matching *any*
// prefix won, and Go randomises map iteration.
func TestGetIdxPrefix_HonoursPrecedence(t *testing.T) {
	hm := map[string]int{
		"lasttransactionprice": 7, // first prefix — must always win
		"closeprice":           9, // third prefix
	}
	for i := 0; i < 2000; i++ {
		idx, ok := getIdxPrefix(hm, "lasttransactionprice", "lastprice", "closeprice")
		if !ok || idx != 7 {
			t.Fatalf("iteration %d: got column %d (ok=%v), want 7", i, idx, ok)
		}
	}
}

// Two headers sharing one prefix must resolve the same way every time.
func TestGetIdxPrefix_IsDeterministic(t *testing.T) {
	hm := map[string]int{
		"lastprice":         1,
		"lastpricecurrency": 2,
	}
	seen := map[int]bool{}
	for i := 0; i < 2000; i++ {
		idx, _ := getIdxPrefix(hm, "lastprice")
		seen[idx] = true
	}
	if len(seen) != 1 {
		t.Errorf("same header set resolved to %d different columns: %v", len(seen), seen)
	}
	// The more specific header is the shorter one, and it is the one meant.
	if !seen[1] {
		t.Errorf("chose the longer header; want column 1 (lastprice)")
	}
}

// Every column of the real GSE export still resolves to the right index.
func TestGetIdxPrefix_ResolvesLiveExportHeaders(t *testing.T) {
	headers := []string{
		"Daily Date", "Share Code", "Year High (GH¢)", "Year Low (GH¢)",
		"Previous Closing Price - VWAP (GH¢)", "Opening Price (GH¢)",
		"Last Transaction Price (GH¢)", "Closing Price - VWAP (GH¢)",
		"Price Change (GH¢)", "Closing Bid Price (GH¢)", "Closing Offer Price (GH¢)",
		"Total Shares Traded", "Total Value Traded (GH¢)",
	}
	hm := map[string]int{}
	for i, h := range headers {
		hm[normalizeHeader(h)] = i
	}
	want := []struct {
		col      int
		prefixes []string
	}{
		{0, []string{"dailydate"}},
		{1, []string{"sharecode", "symbol"}},
		{2, []string{"yearhigh"}},
		{3, []string{"yearlow"}},
		{4, []string{"previousclosingprice"}},
		{5, []string{"openingprice", "openprice"}},
		{6, []string{"lasttransactionprice", "lastprice", "closeprice"}},
		{7, []string{"closingpricevwap"}},
		{8, []string{"pricechange"}},
		{9, []string{"closingbidprice"}},
		{10, []string{"closingofferprice"}},
		{11, []string{"totalsharestraded", "volume"}},
		{12, []string{"totalvaluetraded"}},
	}
	for _, tc := range want {
		got, ok := getIdxPrefix(hm, tc.prefixes...)
		if !ok || got != tc.col {
			t.Errorf("getIdxPrefix(%v) = %d (ok=%v), want %d (%q)",
				tc.prefixes, got, ok, tc.col, headers[tc.col])
		}
	}
}

// A symbol outside the ticker charset must be rejected, not stored — it
// could never be queried, and it renders into an HTML response.
func TestParseRecord_RejectsMalformedSymbol(t *testing.T) {
	hm := map[string]int{"dailydate": 0, "sharecode": 1}
	for _, sym := range []string{
		`<script src="https://cdn.jsdelivr.net/npm/x"></script>`,
		`" onfocus="alert(1)`,
		"lowercase",
		"-LEAD",
		"TRAIL-",
	} {
		if _, err := parseRecord([]string{"01/09/2026", sym}, hm); err == nil {
			t.Errorf("parseRecord accepted symbol %q", sym)
		}
	}
	// The real separator-bearing tickers must survive, footnote asterisks
	// and all.
	for _, sym := range []string{"MTNGH", "SCB PREF", "GGBL RE", "SG-SSB", "**ALW**", "PBC**"} {
		if _, err := parseRecord([]string{"01/09/2026", sym}, hm); err != nil {
			t.Errorf("parseRecord rejected real symbol %q: %v", sym, err)
		}
	}
}

// A short row used to abort the whole file at csvReader.Read, and an
// unchecked record[idx] would panic once we started skipping past it.
func TestParseRecord_ToleratesShortRows(t *testing.T) {
	hm := map[string]int{
		"dailydate": 0, "sharecode": 1, "yearhigh": 2, "totalsharestraded": 11,
	}
	// Row stops after the symbol; every later column is missing.
	tick, err := parseRecord([]string{"01/09/2026", "MTNGH"}, hm)
	if err != nil {
		t.Fatalf("short row rejected: %v", err)
	}
	if tick.Symbol != "MTNGH" {
		t.Errorf("symbol = %q, want MTNGH", tick.Symbol)
	}
	if tick.YearHigh != 0 || tick.TotalVolume != 0 {
		t.Errorf("missing columns should read as zero, got high=%v vol=%v", tick.YearHigh, tick.TotalVolume)
	}
}

func TestField_BoundsChecked(t *testing.T) {
	rec := []string{"a", "b"}
	for _, tc := range []struct {
		idx  int
		want string
	}{
		{0, "a"}, {1, "b"}, {2, ""}, {99, ""}, {-1, ""},
	} {
		if got := field(rec, tc.idx); got != tc.want {
			t.Errorf("field(%v, %d) = %q, want %q", rec, tc.idx, got, tc.want)
		}
	}
}

// GSE published two spellings for the same instrument, splitting its stored
// history in two. Folding at ingest keeps a re-appearance of the old form
// from starting a second series again.
func TestParseRecord_FoldsAliasSpellings(t *testing.T) {
	hm := map[string]int{"dailydate": 0, "sharecode": 1}

	cases := map[string]string{
		"SCB PREF":   "SCBPREF",
		"CAL PREF":   "CALPREF",
		"SCB PREF**": "SCBPREF", // footnote markers are stripped first
		"SCBPREF":    "SCBPREF", // already canonical, unchanged
		"CALPREF":    "CALPREF",
	}
	for in, want := range cases {
		tick, err := parseRecord([]string{"01/09/2026", in}, hm)
		if err != nil {
			t.Errorf("parseRecord(%q): %v", in, err)
			continue
		}
		if tick.Symbol != want {
			t.Errorf("parseRecord(%q).Symbol = %q, want %q", in, tick.Symbol, want)
		}
	}
}

// Distinct securities must not be folded together. A preference share and a
// rights issue are separate instruments from the ordinary line, and SG-SSB's
// hyphen is part of its only spelling.
func TestSymbolAliases_DoNotOverreach(t *testing.T) {
	for _, sym := range []string{"SG-SSB", "GGBL RE", "ALW RE", "SCB", "CAL", "GGBL", "ALW"} {
		if got := canonicalSymbol(sym); got != sym {
			t.Errorf("canonicalSymbol(%q) = %q; that is a different security, not an alias", sym, got)
		}
	}
}

// Every alias target must itself be a ticker the API can query, or ingest
// would write rows no endpoint can reach.
func TestSymbolAliases_TargetsAreValid(t *testing.T) {
	for from, to := range symbolAliases {
		if !ValidSymbol(to) {
			t.Errorf("alias %q -> %q: target is not a well-formed ticker", from, to)
		}
		if _, chained := symbolAliases[to]; chained {
			t.Errorf("alias %q -> %q: target is itself an alias, so folding depends on map order", from, to)
		}
	}
}
