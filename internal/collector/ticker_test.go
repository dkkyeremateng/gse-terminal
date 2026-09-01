package collector

import (
	"math"
	"testing"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/repository"
)

func TestQuotesFromTicksCarriesEveryColumn(t *testing.T) {
	tick := repository.Tick{
		TradingDate:    time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC),
		Symbol:         "MTNGH",
		YearHigh:       4.20,
		YearLow:        2.10,
		PrevCloseVWAP:  3.40,
		OpenPrice:      3.41,
		LastPrice:      3.45,
		ClosePriceVWAP: 3.44,
		PriceChange:    0.05,
		BidPrice:       3.43,
		OfferPrice:     3.46,
		TotalVolume:    120_000,
		TotalValue:     414_000,
	}

	got := quotesFromTicks([]repository.Tick{tick})
	if len(got) != 1 {
		t.Fatalf("got %d quotes, want 1", len(got))
	}
	q := got[0]

	want := LiveQuote{
		Symbol: "MTNGH", TradingDate: "2026-08-21",
		YearHigh: 4.20, YearLow: 2.10, PrevCloseVWAP: 3.40,
		OpenPrice: 3.41, LastPrice: 3.45, ClosePriceVWAP: 3.44,
		PriceChange: 0.05, BidPrice: 3.43, OfferPrice: 3.46,
		Volume: 120_000, TotalValue: 414_000,
		Name: "MTNGH", Price: 3.45, Change: 0.05,
		PercentChange: q.PercentChange, // asserted separately below
	}
	if q != want {
		t.Errorf("quote = %+v\nwant %+v", q, want)
	}
	// 0.05 against the previous close of 3.40.
	if pct := 0.05 / 3.40 * 100; math.Abs(q.PercentChange-pct) > 1e-9 {
		t.Errorf("PercentChange = %v, want %v", q.PercentChange, pct)
	}
}

func TestQuotesFromTicksEdgeCases(t *testing.T) {
	ticks := []repository.Tick{
		// Untraded symbol: the export leaves the last-trade price at 0,
		// so the VWAP close has to stand in.
		{Symbol: "ACCESS", LastPrice: 0, ClosePriceVWAP: 30.95, PrevCloseVWAP: 30.95},
		// No previous close (new listing): percent is backed out of the
		// last price rather than dividing by zero.
		{Symbol: "NEWCO", LastPrice: 1.10, PriceChange: 0.10},
		// Rows without a share code are dropped rather than broadcast.
		{Symbol: "", LastPrice: 1.10},
	}

	got := quotesFromTicks(ticks)
	if len(got) != 2 {
		t.Fatalf("got %d quotes, want 2: %+v", len(got), got)
	}
	if got[0].LastPrice != 30.95 || got[0].Price != 30.95 {
		t.Errorf("untraded quote = %+v, want VWAP fallback 30.95", got[0])
	}
	if want := 0.10 / 1.00 * 100; math.Abs(got[1].PercentChange-want) > 1e-9 {
		t.Errorf("new-listing PercentChange = %v, want %v", got[1].PercentChange, want)
	}
}

func TestGetLastTradingDate(t *testing.T) {
	cases := []struct {
		name string
		from string
		want string
	}{
		{"weekday returns itself", "2026-08-21", "2026-08-21"},       // Friday
		{"saturday walks back", "2026-08-22", "2026-08-21"},          // Sat -> Fri
		{"sunday walks back", "2026-08-23", "2026-08-21"},            // Sun -> Fri
		{"holiday walks back", "2026-08-03", "2026-07-31"},           // Founders' Day (Mon) -> Fri
		{"christmas walks past weekend", "2026-12-26", "2026-12-24"}, // Boxing Day (Sat) -> Thu (25th is a holiday)
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			from, err := time.Parse("2006-01-02", tc.from)
			if err != nil {
				t.Fatal(err)
			}
			if got := getLastTradingDate(from).Format("2006-01-02"); got != tc.want {
				t.Errorf("getLastTradingDate(%s) = %s, want %s", tc.from, got, tc.want)
			}
		})
	}
}

func TestScraperConfigDefaults(t *testing.T) {
	got := ScraperConfig{}.withDefaults()
	if got.PythonBin != defaultPythonBin || got.ScriptPath != defaultScriptPath || got.Timeout != defaultScrapeTimeout {
		t.Errorf("zero config did not fill in defaults: %+v", got)
	}

	custom := ScraperConfig{PythonBin: "/venv/bin/python", Timeout: time.Minute}.withDefaults()
	if custom.PythonBin != "/venv/bin/python" || custom.Timeout != time.Minute {
		t.Errorf("explicit values overwritten: %+v", custom)
	}
	if custom.ScriptPath != defaultScriptPath {
		t.Errorf("unset ScriptPath = %q, want default", custom.ScriptPath)
	}
}

func TestLastLines(t *testing.T) {
	stderr := "[launch] browser instance 'x'\n\nTraceback (most recent call last):\n  File \"gse_download.py\", line 1\nRuntimeError: Timed out waiting for the trading table.\n"
	got := lastLines(stderr, 2)
	want := `File "gse_download.py", line 1 | RuntimeError: Timed out waiting for the trading table.`
	if got != want {
		t.Errorf("lastLines() = %q, want %q", got, want)
	}
	if lastLines("only one line", 5) != "only one line" {
		t.Error("short input should pass through unchanged")
	}
}
