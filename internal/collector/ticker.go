package collector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/ingestor"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// LiveQuote is the per-symbol frame pushed to WebSocket clients after a
// scrape. It carries every column the ingestor writes, so a client can patch
// its rows from the frame alone instead of re-fetching /v1/market-summary.
//
// Field names track repository.MarketSummaryItem because that's what the
// consumers assume: ui/src/live/socket.js merges each frame entry into
// window.MARKET_SUMMARY_DATA.all keyed on `symbol`, and patches cells from
// `lastPrice` / `percentChange` / `volume`.
type LiveQuote struct {
	Symbol      string `json:"symbol"`
	TradingDate string `json:"tradingDate"`

	YearHigh       float64 `json:"yearHigh"`
	YearLow        float64 `json:"yearLow"`
	PrevCloseVWAP  float64 `json:"prevCloseVwap"`
	OpenPrice      float64 `json:"openPrice"`
	LastPrice      float64 `json:"lastPrice"`
	ClosePriceVWAP float64 `json:"closePriceVwap"`
	PriceChange    float64 `json:"priceChange"`
	PercentChange  float64 `json:"percentChange"`
	BidPrice       float64 `json:"bidPrice"`
	OfferPrice     float64 `json:"offerPrice"`
	Volume         int64   `json:"volume"`
	TotalValue     float64 `json:"totalValue"`

	// Pre-2026 aliases from the kwayisi-era frame. No client in this repo
	// reads them, but the socket is a public surface — they cost a few
	// bytes per symbol and keep any client we can't see from breaking.
	Name   string  `json:"name"`
	Price  float64 `json:"price"`
	Change float64 `json:"change"`
}

// Site + tooling defaults for the scraper. The heavy lifting lives in
// scripts/gse_download.py, which drives a headless Chrome against
// gse.com.gh's wpDataTables grid and writes the site's own CSV export
// format — the same format the admin upload endpoint already ingests.
const (
	sourceName        = "gse.com.gh"
	sourceURL         = "https://gse.com.gh/trading-and-data/"
	defaultPythonBin  = "python3"
	defaultScriptPath = "scripts/gse_download.py"
	// The script launches a browser, waits on a server-side table filter,
	// then re-draws with every row expanded. A minute is typical; the cap
	// is generous so a slow site doesn't kill an otherwise-fine run.
	defaultScrapeTimeout = 6 * time.Minute
)

// ScraperConfig locates the gse_download.py helper. Zero values fall back to
// the defaults above, so callers with nothing to override can pass the zero
// struct.
type ScraperConfig struct {
	PythonBin  string
	ScriptPath string
	Timeout    time.Duration
}

func (c ScraperConfig) withDefaults() ScraperConfig {
	if c.PythonBin == "" {
		c.PythonBin = defaultPythonBin
	}
	if c.ScriptPath == "" {
		c.ScriptPath = defaultScriptPath
	}
	if c.Timeout <= 0 {
		c.Timeout = defaultScrapeTimeout
	}
	return c
}

// marketClosures lists dates the GSE is known not to have held a session.
//
// It is deliberately NOT the Ghana public-holiday calendar, because the two
// are not the same list. Checked against the 165 sessions actually held in
// 2026 up to 2026-09-01, the previous public-holiday table was wrong in both
// directions:
//
//   - The market TRADED on Constitution Day (Jan 7), Africa Day (May 25) and
//     Republic Day (Jul 1). Those were downgraded to commemorative days by
//     the 2019 amendment to the Public Holidays Act and are not market
//     closures. Listing them made the scheduler skip four real sessions a
//     year for nothing.
//   - The market was CLOSED on 2026-03-20, 2026-03-23 and 2026-05-27 (the
//     Eid observances, which are lunar and shift every year), and on
//     2026-01-09 and 2026-07-03, neither of which is a public holiday at
//     all. None were listed.
//
// The entry for Founders' Day was also a day early: it read 2026-08-03, and
// the market traded on both the 3rd and the actual holiday on the 4th.
//
// Dates through 2026-09-01 are observed — taken from which trading_dates
// exist in QuestDB, which is authoritative because the backfill pulled every
// session GSE published. Later dates are projected from the statutory
// calendar and are best-effort: the Eid dates in particular are declared by
// proclamation and cannot be known this far ahead, so this list WILL be
// incomplete. That is by design; see the two use sites below.
//
// How wrongness here is absorbed:
//
//   - The scheduler no longer consults this list. A holiday simply means the
//     scrape finds an empty export, retries inside its cutoff, and logs. One
//     wasted Chrome launch on ~10 days a year is a far better trade than
//     silently skipping a session the market did hold.
//   - The freshness watchdog does consult it, because there a missing entry
//     only produces a spurious "data is stale" alert. That is the safe
//     direction to be wrong in.
var marketClosures = map[string]string{
	// ── 2026: observed (no session present in QuestDB) ──
	"2026-01-01": "New Year's Day",
	"2026-01-09": "market closed (no session published)",
	"2026-03-06": "Independence Day",
	"2026-03-20": "Eid al-Fitr",
	"2026-03-23": "Eid al-Fitr (observed)",
	"2026-04-03": "Good Friday",
	"2026-04-06": "Easter Monday",
	"2026-05-01": "May Day",
	"2026-05-27": "Eid al-Adha",
	"2026-07-03": "market closed (no session published)",
	// ── 2026: projected, not yet elapsed ──
	"2026-09-21": "Kwame Nkrumah Memorial Day",
	"2026-12-04": "Farmers' Day",
	"2026-12-25": "Christmas Day",
	"2026-12-26": "Boxing Day",

	// ── 2027: projected from the statutory calendar ──
	"2027-01-01": "New Year's Day",
	"2027-03-08": "Independence Day (observed, 6th is a Saturday)",
	"2027-03-26": "Good Friday",
	"2027-03-29": "Easter Monday",
	"2027-05-03": "May Day (observed, 1st is a Saturday)",
	"2027-08-04": "Founders' Day",
	"2027-09-21": "Kwame Nkrumah Memorial Day",
	"2027-12-03": "Farmers' Day",
	"2027-12-27": "Christmas Day (observed, 25th is a Saturday)",
	"2027-12-28": "Boxing Day (observed, 26th is a Sunday)",

	// ── 2028: projected from the statutory calendar ──
	"2028-01-03": "New Year's Day (observed, 1st is a Saturday)",
	"2028-03-06": "Independence Day",
	"2028-04-14": "Good Friday",
	"2028-04-17": "Easter Monday",
	"2028-05-01": "May Day",
	"2028-08-04": "Founders' Day",
	"2028-09-21": "Kwame Nkrumah Memorial Day",
	"2028-12-01": "Farmers' Day",
	"2028-12-25": "Christmas Day",
	"2028-12-26": "Boxing Day",
}

// closureCalendarThrough is the last date marketClosures makes any claim
// about. Past it the map is empty, every holiday reads as a trading day, and
// the freshness watchdog starts crying wolf on real closures.
//
// The previous table ran out at 2026-12-31 with nothing to say so. Rather
// than move that cliff quietly, checkClosureCalendar warns while there is
// still time to extend it — a hard-coded calendar with no expiry warning is
// how this rots in the first place.
var closureCalendarThrough = time.Date(2028, 12, 31, 0, 0, 0, 0, time.UTC)

// closureCalendarWarnWithin is how far ahead of the horizon to start
// complaining. A quarter is enough notice to look up the next year's gazette
// without it becoming background noise.
const closureCalendarWarnWithin = 90 * 24 * time.Hour

// isMarketClosure reports whether the date is a known non-trading day.
func isMarketClosure(t time.Time) (string, bool) {
	name, ok := marketClosures[t.Format("2006-01-02")]
	return name, ok
}

// checkClosureCalendar logs when the closure calendar is close to, or past,
// the last date it covers. Called at startup and from the freshness
// watchdog, so an unattended deployment surfaces it either way.
func checkClosureCalendar(now time.Time, logger *slog.Logger) {
	switch {
	case now.After(closureCalendarThrough):
		logger.Error("Market closure calendar has expired; every holiday now reads as a trading day and the freshness watchdog will report false staleness",
			"coveredThrough", closureCalendarThrough.Format("2006-01-02"))
	case now.Add(closureCalendarWarnWithin).After(closureCalendarThrough):
		logger.Warn("Market closure calendar expires soon; extend marketClosures in internal/collector/ticker.go",
			"coveredThrough", closureCalendarThrough.Format("2006-01-02"),
			"daysRemaining", int(closureCalendarThrough.Sub(now).Hours()/24))
	}
}

// CacheInvalidator is the narrow interface the collector needs to wipe the
// derived-data cache after a successful scrape. PostgresRepo isn't involved;
// only RedisRepo satisfies it. Defining it locally keeps the collector
// package free of a hard dependency on the repository package's public API.
type CacheInvalidator interface {
	InvalidatePattern(ctx context.Context, pattern string) error
}

// AuditSink is the narrow interface the collector needs to record a scrape
// event in the audit log. The server's audit.Logger satisfies it; declared
// here so we don't import the audit package directly.
type AuditSink interface {
	Log(ctx context.Context, action, targetType, targetID string, metadata map[string]interface{})
}

// PostScrapeHook runs after a successful scrape. Implementations handle
// anomaly detection, daily briefing generation, watchList digest push
// notifications, etc. Nil is safe to pass.
type PostScrapeHook interface {
	RunPostScrape(ctx context.Context, qdb *repository.QuestDBRepo, symbols []string)
	// DispatchWatchListDigest is called once per scrape with the freshly-
	// ingested live frame. Implementations fan out a Web Push notification
	// to every subscribed user with a non-empty watchList. Best-effort —
	// failures should be logged, not propagated.
	DispatchWatchListDigest(ctx context.Context, snapshot []LiveQuote)
}

// StartDaemon initializes a background worker that pulls the official GSE
// "Daily Shares & ETFs" table via scripts/gse_download.py once a day at
// scrapeHourUTC. `cache` and `auditLog` may both be nil for tests / minimal
// deployments.
//
// The scraper needs python3 plus the chrome-agent CLI on PATH. When the
// script isn't present the daemon logs and exits rather than failing a
// browser launch every afternoon — CSV upload remains the ingest path.
// The exchange publishes the "Daily Shares & ETFs" table some time after
// the close, and not at a fixed minute. Measured on 2026-09-01: the export
// was still empty at 15:22 and again at 15:30, and held 41 rows when next
// probed at 16:38 — so the previous 15:30 schedule fired before the data
// existed and every scheduled run returned "GSE export contained no rows".
// Nothing errored; the day was simply never ingested.
//
// 16:30 is an hour later than the old schedule and past the point where the
// export was still empty. Note it is 8 minutes earlier than the only
// confirmed positive observation (16:38), so on a day the exchange publishes
// late the run can still find an empty table. That degrades to the previous
// behaviour for that day -- a WARN and no ingest -- rather than to anything
// worse, and the weekday/holiday logic below is unchanged, so this applies
// to every trading date.
const (
	scrapeHourUTC   = 16
	scrapeMinuteUTC = 30

	// Retry window for a scheduled run that ingested nothing. The cutoff
	// bounds it, so a genuinely dataless day -- an unlisted holiday -- stops
	// after a few attempts rather than retrying until the next schedule.
	scrapeRetryInterval = 20 * time.Minute
	scrapeRetryCutoff   = 3 * time.Hour

	// Freshness watchdog. Two trading days allows one wholly missed session
	// before escalating, so a single late publication is not an outage.
	freshnessCheckInterval = 1 * time.Hour
	staleTradingDays       = 2
)

func StartDaemon(ctx context.Context, qdb *repository.QuestDBRepo, cache CacheInvalidator, auditLog AuditSink, cfg ScraperConfig, broadcast chan []byte, anomaly PostScrapeHook) {
	cfg = cfg.withDefaults()
	go func() {
		// Wait a few seconds for the system to boot
		time.Sleep(2 * time.Second)

		logger := slog.With("component", "collector")

		if _, err := os.Stat(cfg.ScriptPath); err != nil {
			logger.Warn("Automated GSE scrape disabled: download script not found",
				"script", cfg.ScriptPath, "error", err)
			return
		}
		logger.Info("GSE scraper initialized", "source", sourceName,
			"script", cfg.ScriptPath,
			"schedule", fmt.Sprintf("%02d:%02d UTC daily", scrapeHourUTC, scrapeMinuteUTC))

		checkClosureCalendar(time.Now().UTC(), logger)

		go watchDataFreshness(ctx, qdb, auditLog)

		// Seed scrape on boot, but only when the newest trading day we
		// hold is already behind the market. Skipping the no-op case
		// matters more here than it used to: each run launches a real
		// Chrome, so an unconditional seed would pay that cost on every
		// restart / redeploy.
		if target := getLastTradingDate(time.Now().UTC()); needsScrape(ctx, qdb, target, logger) {
			logger.Info("Performing initial seed scrape on startup...", "tradingDate", target.Format("2006-01-02"))
			scrapeGSE(ctx, qdb, cache, auditLog, cfg, broadcast, anomaly)
		} else {
			logger.Info("Skipping seed scrape — QuestDB already has the latest trading day")
		}

		for {
			now := time.Now().UTC()
			nextRun := time.Date(now.Year(), now.Month(), now.Day(),
				scrapeHourUTC, scrapeMinuteUTC, 0, 0, time.UTC)

			// If it's already past or exactly the scrape time today, plan for tomorrow
			if !nextRun.After(now) {
				nextRun = nextRun.Add(24 * time.Hour)
			}

			// Advance to the next weekday. Weekends are the only skip we
			// make: the GSE has never held a Saturday session, so that
			// cannot cost us data.
			//
			// The closure calendar is deliberately NOT consulted here. It
			// used to be, and it was wrong in the expensive direction —
			// Constitution Day, Africa Day, Republic Day and a
			// day-early Founders' Day were all listed, and the market
			// traded on every one of them, so the scheduler skipped four
			// real sessions a year and nothing said so. Running the scrape
			// on an actual holiday costs one Chrome launch; the export
			// comes back empty, scrapeWithRetry retries inside its cutoff
			// and gives up with a log. That is the cheap direction to be
			// wrong in.
			for nextRun.Weekday() == time.Saturday || nextRun.Weekday() == time.Sunday {
				nextRun = nextRun.Add(24 * time.Hour)
			}
			if name, closed := isMarketClosure(nextRun); closed {
				// Advisory only — we still run. Worth logging so an empty
				// export on this date reads as expected rather than as a
				// scraper fault.
				logger.Info("Next scheduled scrape falls on a known market closure; running anyway",
					"date", nextRun.Format("2006-01-02"), "closure", name)
			}

			duration := nextRun.Sub(now)
			logger.Info("Waiting for next scheduled scrape", "duration", duration.String(), "at", nextRun.Format(time.RFC1123))

			timer := time.NewTimer(duration)

			select {
			case <-ctx.Done():
				timer.Stop()
				logger.Info("Shutting down tick engine")
				return
			case <-timer.C:
				scrapeWithRetry(ctx, qdb, cache, auditLog, cfg, broadcast, anomaly)
			}
		}
	}()
}

// scrapeGSE reports whether rows were actually ingested. Every early return
// -- download failure, unreadable file, ingest error, empty export -- yields
// false so the caller can decide whether to retry. Previously all of these
// were indistinguishable from success to the scheduler.
func scrapeGSE(ctx context.Context, qdb *repository.QuestDBRepo, cache CacheInvalidator, auditLog AuditSink, cfg ScraperConfig, broadcast chan []byte, anomaly PostScrapeHook) bool {
	logger := slog.With("component", "collector")
	tradingDate := getLastTradingDate(time.Now().UTC())

	csvPath, err := downloadDailyShares(ctx, cfg, tradingDate)
	if err != nil {
		logger.Error("GSE download failed", "tradingDate", tradingDate.Format("2006-01-02"), "error", err)
		if auditLog != nil {
			auditLog.Log(ctx, "data.scrape.failure", "ingestion", sourceName, map[string]interface{}{
				"error": err.Error(),
				"stage": "download",
			})
		}
		return false
	}
	defer os.Remove(csvPath)

	file, err := os.Open(csvPath)
	if err != nil {
		logger.Error("Cannot read downloaded GSE export", "path", csvPath, "error", err)
		return false
	}
	defer file.Close()

	// Same parser the admin CSV upload uses — gse_download.py writes the
	// site's own export format, so the scheduled scrape and a hand-uploaded
	// file go through one code path. Ingest also flushes the ILP buffer,
	// and QuestDB's DEDUPLICATE UPSERT KEYS(trading_date, symbol) means a
	// re-run of the same day replaces rows instead of duplicating them.
	res, ticks, err := ingestor.NewIngestor(qdb).IngestTicks(ctx, file)
	if err != nil {
		logger.Error("Ingest of GSE export failed", "inserted", res.Inserted, "error", err)
		if auditLog != nil {
			auditLog.Log(ctx, "data.scrape.failure", "ingestion", sourceName, map[string]interface{}{
				"error":   err.Error(),
				"stage":   "ingest",
				"records": res.Inserted,
			})
		}
		return false
	}
	if res.Inserted == 0 {
		// The site returns an empty grid for a date it has no data for —
		// an unlisted holiday, or a session whose file hasn't been
		// published yet. Nothing to broadcast or invalidate.
		logger.Warn("GSE export contained no rows", "tradingDate", tradingDate.Format("2006-01-02"), "skipped", res.Skipped)
		return false
	}
	if res.Skipped > 0 {
		logger.Warn("Skipped malformed rows in GSE export", "count", res.Skipped)
	}

	liveData := quotesFromTicks(ticks)
	logger.Info("Ingested GSE daily export", "records", res.Inserted,
		"tradingDate", tradingDate.Format("2006-01-02"))

	// Broadcast the full frame to all connected WebSockets
	if broadcast != nil && len(liveData) > 0 {
		if msg, err := json.Marshal(liveData); err == nil {
			select {
			case broadcast <- msg:
			default:
				// Buffer full, skip this frame
			}
		}
	}

	// Wipe the derived-data cache so the next request hydrates from the
	// fresh equities snapshot. Same namespace as HandleUpload.
	if cache != nil {
		if err := cache.InvalidatePattern(ctx, "gse:data:*"); err != nil {
			logger.Warn("cache invalidation after scrape failed", "error", err)
		} else {
			logger.Info("Stock cache cleared after scrape")
		}
	}

	// Tell connected clients their own in-memory caches are stale. Same
	// frame the server package sends on admin upload. Best-effort — a
	// full Broadcast buffer drops the bust and clients fall back to TTL.
	if broadcast != nil {
		select {
		case broadcast <- []byte(`{"type":"cache:bust"}`):
		default:
		}
	}

	// Record the successful scrape so the admin audit log shows automated
	// ingestion runs alongside manual CSV uploads.
	if auditLog != nil {
		auditLog.Log(ctx, "data.scrape", "ingestion", sourceName, map[string]interface{}{
			"records":     res.Inserted,
			"skipped":     res.Skipped,
			"tradingDate": tradingDate.Format("2006-01-02"),
			"source":      sourceURL,
		})
	}

	// Run anomaly detection on the freshly ingested symbols, then fan out
	// the watchList digest push. Both are best-effort — neither blocks the
	// scrape's primary purpose (data ingest already completed above).
	if anomaly != nil {
		var symbols []string
		for _, s := range liveData {
			if s.Symbol != "" {
				symbols = append(symbols, s.Symbol)
			}
		}
		anomaly.RunPostScrape(ctx, qdb, symbols)
		anomaly.DispatchWatchListDigest(ctx, liveData)
	}

	return true
}

// scrapeWithRetry runs a scheduled scrape and, when it ingests nothing,
// keeps retrying on an interval until it succeeds or the cutoff passes.
//
// The exchange does not publish at a fixed minute, so any single scheduled
// time is a bet: fire before publication and the run finds an empty table,
// logs a WARN, and waits a full day while that session is never ingested.
// Retrying makes the scheduled time a lower bound instead, and absorbs a
// transient download failure along the way.
func scrapeWithRetry(ctx context.Context, qdb *repository.QuestDBRepo, cache CacheInvalidator, auditLog AuditSink, cfg ScraperConfig, broadcast chan []byte, anomaly PostScrapeHook) {
	logger := slog.With("component", "collector")
	deadline := time.Now().UTC().Add(scrapeRetryCutoff)

	for attempt := 1; ; attempt++ {
		if scrapeGSE(ctx, qdb, cache, auditLog, cfg, broadcast, anomaly) {
			if attempt > 1 {
				logger.Info("Scrape succeeded on retry", "attempt", attempt)
			}
			return
		}
		if !time.Now().UTC().Add(scrapeRetryInterval).Before(deadline) {
			logger.Error("Scrape found no data before the retry cutoff; this session will not be ingested today",
				"attempts", attempt, "cutoff", scrapeRetryCutoff.String())
			if auditLog != nil {
				auditLog.Log(ctx, "data.scrape.exhausted", "ingestion", sourceName, map[string]interface{}{
					"attempts": attempt,
					"cutoff":   scrapeRetryCutoff.String(),
				})
			}
			return
		}
		logger.Warn("Scrape ingested nothing; retrying",
			"attempt", attempt, "retryIn", scrapeRetryInterval.String())

		t := time.NewTimer(scrapeRetryInterval)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// watchDataFreshness periodically compares the newest trading date held
// against the newest the market should have produced, and escalates when it
// falls behind. Without it a broken scrape is invisible: the app stays
// healthy, the site serves, and the data simply stops advancing.
func watchDataFreshness(ctx context.Context, qdb *repository.QuestDBRepo, auditLog AuditSink) {
	logger := slog.With("component", "collector")
	ticker := time.NewTicker(freshnessCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			checkClosureCalendar(time.Now().UTC(), logger)
			latest, err := qdb.GetLastIngestionTime(ctx)
			if err != nil {
				logger.Warn("Freshness check could not read the latest trading date", "error", err)
				continue
			}
			expected := getLastTradingDate(time.Now().UTC())
			behind := tradingDaysBetween(latest, expected)
			if behind < staleTradingDays {
				continue
			}
			logger.Error("Market data is stale",
				"latestHeld", latest.Format("2006-01-02"),
				"expected", expected.Format("2006-01-02"),
				"tradingDaysBehind", behind)
			if auditLog != nil {
				auditLog.Log(ctx, "data.freshness.stale", "ingestion", sourceName, map[string]interface{}{
					"latest_held":         latest.Format("2006-01-02"),
					"expected":            expected.Format("2006-01-02"),
					"trading_days_behind": behind,
				})
			}
		}
	}
}

// tradingDaysBetween counts weekday, non-closure days after `from` up to and
// including `to`. Weekends and known market closures are not missing data, so
// they must not count towards staleness -- otherwise every Monday would look
// like a two-day outage.
//
// This is the safe place for the closure calendar to be incomplete: a
// closure we do not know about inflates the count and can produce a
// spurious stale alert, which someone then investigates. The scheduler
// deliberately does not use it, because there being wrong loses a session
// silently.
func tradingDaysBetween(from, to time.Time) int {
	from = time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, time.UTC)
	to = time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, time.UTC)

	n := 0
	for d := from.AddDate(0, 0, 1); !d.After(to); d = d.AddDate(0, 0, 1) {
		if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			continue
		}
		if _, closed := isMarketClosure(d); closed {
			continue
		}
		n++
	}
	return n
}

// downloadDailyShares runs gse_download.py for a single trading day and
// returns the path of the CSV it wrote. The caller owns the file and must
// remove it. The script's own timeout is unbounded, so the context cap is
// what stops a wedged browser from parking a goroutine until shutdown.
func downloadDailyShares(ctx context.Context, cfg ScraperConfig, day time.Time) (string, error) {
	tmp, err := os.CreateTemp("", "gse_daily_*.csv")
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	path := tmp.Name()
	tmp.Close() // the script opens the path itself

	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()

	// The script takes the site's own DD/MM/YYYY filter format. One date
	// means exactly that session (from == to).
	cmd := exec.CommandContext(ctx, cfg.PythonBin, cfg.ScriptPath, day.Format("02/01/2006"), "-o", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		os.Remove(path)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", fmt.Errorf("gse_download.py timed out after %s: %w", cfg.Timeout, ctxErr)
		}
		return "", fmt.Errorf("gse_download.py: %w: %s", err, lastLines(stderr.String(), 5))
	}
	return path, nil
}

// lastLines trims a captured stderr stream down to its final n non-empty
// lines — enough to carry a Python traceback's actual error without dumping
// the whole frame stack into a log line.
func lastLines(s string, n int) string {
	var kept []string
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			kept = append(kept, line)
		}
	}
	if len(kept) > n {
		kept = kept[len(kept)-n:]
	}
	return strings.Join(kept, " | ")
}

// quotesFromTicks projects freshly-ingested EOD rows onto the live frame
// shape WebSocket clients expect, carrying every column through.
func quotesFromTicks(ticks []repository.Tick) []LiveQuote {
	out := make([]LiveQuote, 0, len(ticks))
	for _, t := range ticks {
		if t.Symbol == "" {
			continue
		}
		// Untraded symbols carry a zero last-trade price in the export, so
		// the VWAP close stands in — otherwise a quiet counter flashes to
		// 0.00 in the ticker tape.
		last := t.LastPrice
		if last == 0 {
			last = t.ClosePriceVWAP
		}

		q := LiveQuote{
			Symbol:         t.Symbol,
			TradingDate:    t.TradingDate.Format("2006-01-02"),
			YearHigh:       t.YearHigh,
			YearLow:        t.YearLow,
			PrevCloseVWAP:  t.PrevCloseVWAP,
			OpenPrice:      t.OpenPrice,
			LastPrice:      last,
			ClosePriceVWAP: t.ClosePriceVWAP,
			PriceChange:    t.PriceChange,
			BidPrice:       t.BidPrice,
			OfferPrice:     t.OfferPrice,
			Volume:         t.TotalVolume,
			TotalValue:     t.TotalValue,

			Name:   t.Symbol,
			Price:  last,
			Change: t.PriceChange,
		}

		// The export's Price Change column is measured against the previous
		// session's VWAP close, so the percentage uses the same base. When
		// the export omits that close (new listing), back it out of the
		// last price instead.
		switch {
		case t.PrevCloseVWAP > 0:
			q.PercentChange = t.PriceChange / t.PrevCloseVWAP * 100
		default:
			if prev := last - t.PriceChange; prev > 0 {
				q.PercentChange = t.PriceChange / prev * 100
			}
		}

		out = append(out, q)
	}
	return out
}

// needsScrape reports whether QuestDB is missing the given trading day. A
// lookup failure answers true: re-scraping costs a browser run, while
// skipping on a transient error would leave the day unfilled until tomorrow.
func needsScrape(ctx context.Context, qdb *repository.QuestDBRepo, target time.Time, logger *slog.Logger) bool {
	latest, err := qdb.GetLastIngestionTime(ctx)
	if err != nil {
		logger.Warn("Could not read latest trading date, scraping anyway", "error", err)
		return true
	}
	return latest.Before(target)
}

// getLastTradingDate returns the most recent valid trading date on the GSE.
func getLastTradingDate(t time.Time) time.Time {
	date := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	for {
		if date.Weekday() == time.Saturday || date.Weekday() == time.Sunday {
			date = date.AddDate(0, 0, -1)
			continue
		}

		if _, closed := isMarketClosure(date); closed {
			date = date.AddDate(0, 0, -1)
			continue
		}

		break
	}
	return date
}
