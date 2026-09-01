package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// ── Portfolio summary (with live P&L) ────────────────────────────────

// PortfolioItem is one holding enriched with live market data.
type PortfolioItem struct {
	repository.PortfolioHolding
	CurrentPrice float64 `json:"currentPrice"`
	MarketValue  float64 `json:"marketValue"`
	CostValue    float64 `json:"costValue"`
	PnL          float64 `json:"pnl"`
	PnLPct       float64 `json:"pnlPct"`
	Sector       string  `json:"sector"`
}

// PortfolioSummary is the top-level response for GET /v1/me/portfolio.
//
// TodayPnL / TodayPnLPct describe the single-day move (today's close vs
// yesterday's) aggregated across holdings — distinct from TotalPnL, which
// is cumulative vs the user's cost basis. Both fields power the landing
// "Your Portfolio Today" card that sits beside the daily market briefing.
type PortfolioSummary struct {
	Holdings     []PortfolioItem        `json:"holdings"`
	TotalValue   float64                `json:"totalValue"`
	TotalCost    float64                `json:"totalCost"`
	TotalPnL     float64                `json:"totalPnl"`
	TotalPnLPct  float64                `json:"totalPnlPct"`
	TodayPnL     float64                `json:"todayPnl"`
	TodayPnLPct  float64                `json:"todayPnlPct"`
	SectorExposure map[string]float64   `json:"sectorExposure"` // sector → % of total value
	HoldingCount int                    `json:"holdingCount"`
}

// HandleListPortfolio returns the user's holdings enriched with live
// prices, P&L, and sector exposure. The heavy lifting is just a
// join-in-Go between the holdings rows and the cached market snapshot.
func (s *Server) HandleListPortfolio(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	holdings, err := s.pgRepo.ListPortfolioHoldings(r.Context(), user.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load portfolio")
		return
	}

	// Build a price + sector + today-change lookup from the cached market
	// snapshot. priceChange is today's close − yesterday's close in ¢
	// per share; combined with Quantity it gives the per-holding slice of
	// the day's P&L that the "Your Portfolio Today" card headlines.
	prices := make(map[string]float64)
	priceChanges := make(map[string]float64)
	summaryItems, _ := s.cachedMarketSummaryItems(r.Context())
	for _, item := range summaryItems {
		prices[item.Symbol] = item.LastPrice
		priceChanges[item.Symbol] = item.PriceChange
	}

	var items []PortfolioItem
	var totalValue, totalCost float64
	var todayPnL, prevValue float64
	sectorValue := make(map[string]float64)

	for _, h := range holdings {
		price := prices[h.Symbol]
		costVal := h.Quantity * h.CostBasis
		mktVal := h.Quantity * price
		pnl := mktVal - costVal
		pnlPct := 0.0
		if costVal > 0 {
			pnlPct = math.Round(pnl/costVal*10000) / 100
		}

		// Today-only contribution. A symbol missing from the snapshot (no
		// print today, illiquid) contributes 0 — correct default.
		dayDelta := priceChanges[h.Symbol] * h.Quantity
		todayPnL += dayDelta
		prevValue += mktVal - dayDelta

		sector := s.getSector(h.Symbol)

		items = append(items, PortfolioItem{
			PortfolioHolding: h,
			CurrentPrice:     price,
			MarketValue:      math.Round(mktVal*100) / 100,
			CostValue:        math.Round(costVal*100) / 100,
			PnL:              math.Round(pnl*100) / 100,
			PnLPct:           pnlPct,
			Sector:           sector,
		})

		totalValue += mktVal
		totalCost += costVal
		sectorValue[sector] += mktVal
	}

	// Convert sector values to percentages.
	sectorExposure := make(map[string]float64, len(sectorValue))
	for sec, val := range sectorValue {
		if totalValue > 0 {
			sectorExposure[sec] = math.Round(val/totalValue*10000) / 100
		}
	}

	totalPnLPct := 0.0
	if totalCost > 0 {
		totalPnLPct = math.Round((totalValue-totalCost)/totalCost*10000) / 100
	}

	todayPnLPct := 0.0
	if prevValue > 0 {
		todayPnLPct = math.Round(todayPnL/prevValue*10000) / 100
	}

	// HoldingCount tracks distinct securities the user owns, not the
	// number of purchase lots. Two buys of MTNGH is one holding, not two.
	distinctSymbols := make(map[string]struct{}, len(items))
	for _, it := range items {
		distinctSymbols[it.Symbol] = struct{}{}
	}

	respondJSON(w, PortfolioSummary{
		Holdings:       items,
		TotalValue:     math.Round(totalValue*100) / 100,
		TotalCost:      math.Round(totalCost*100) / 100,
		TotalPnL:       math.Round((totalValue-totalCost)*100) / 100,
		TotalPnLPct:    totalPnLPct,
		TodayPnL:       math.Round(todayPnL*100) / 100,
		TodayPnLPct:    todayPnLPct,
		SectorExposure: sectorExposure,
		HoldingCount:   len(distinctSymbols),
	})
}

// getSector looks up the sector for a symbol using the existing
// two-layer system (admin overrides → seed). Returns "Other" when
// no mapping exists.
func (s *Server) getSector(symbol string) string {
	sec := repository.GetSector(symbol)
	if sec == "" {
		return "Other"
	}
	return sec
}

// ── Portfolio history (equity curve) ─────────────────────────────────

// PortfolioHistoryPoint is one date-value point on the equity curve.
// `Date` is an ISO date string (YYYY-MM-DD); `Value` is the ¢
// portfolio value reconstructed from closes on that date.
//
// `Cashflow` is the **market value** added to the portfolio on that
// date because of new purchases — Σ(quantity × close_d) for every
// holding whose purchase_date is exactly d — plus any OHLC-transition
// delta when a holding's first market price lands on a date after
// its purchase. That's the correct cashflow for the client's return
// series: `(value − prev_value − cashflow)` isolates the market-only
// return of the pre-existing portfolio. Using cost_basis here would
// leak the cost/market gap into returns.
//
// Cost used to be a third field (sum of qty × cost_basis for every
// currently-owned holding) but was only consumed by the old
// cost-basis-ROI curve; the current money-weighted return uses value
// + cashflow only, so Cost was dropped to keep the payload lean.
type PortfolioHistoryPoint struct {
	Date     string  `json:"date"`
	Value    float64 `json:"value"`
	Cashflow float64 `json:"cashflow"`
}

// PortfolioHistoryResponse is the envelope returned by
// GET /v1/me/portfolio/history. The window echoes the requested range
// (a known allowlist value; see portfolioWindow below) so the client
// can verify what it actually got.
type PortfolioHistoryResponse struct {
	Window string                  `json:"window"`
	Points []PortfolioHistoryPoint `json:"points"`
}

// portfolioWindow translates a `window` query param into a start date
// clamp. Returns (startDate, ok). The zero time.Time indicates "no
// clamp — use the full series", used by the `all` window.
func portfolioWindow(window string, now time.Time) (time.Time, bool) {
	now = now.UTC().Truncate(24 * time.Hour)
	switch window {
	case "30d":
		return now.AddDate(0, 0, -30), true
	case "90d":
		return now.AddDate(0, 0, -90), true
	case "ytd":
		return time.Date(now.Year(), 1, 1, 0, 0, 0, 0, time.UTC), true
	case "1y":
		return now.AddDate(-1, 0, 0), true
	case "all":
		return time.Time{}, true
	default:
		return time.Time{}, false
	}
}

// portfolioHistoryCacheKey returns the Redis key a reconstructed
// history response is cached under. Scoped by userID + window so the
// invalidation pattern `portfolio:history:<userID>:*` flushes every
// window variant in one sweep on any holding CRUD.
func portfolioHistoryCacheKey(userID int, window string) string {
	return fmt.Sprintf("portfolio:history:%d:%s", userID, window)
}

// portfolioHistoryCacheTTL bounds how stale a cached response can be.
// 15 minutes balances hit rate against freshness: OHLC tick ingestion
// runs every few minutes during market hours so a 15-minute ceiling
// gives users eventual consistency without flushing the cache faster
// than it's worth building. Explicit CRUD invalidation via
// invalidatePortfolioHistoryCache makes the TTL a safety-net ceiling,
// not the primary freshness mechanism.
const portfolioHistoryCacheTTL = 15 * time.Minute

// invalidatePortfolioHistoryCache drops every cached window for a
// user. Called from holding CRUD so the next dashboard read rebuilds
// against current holdings. Soft-fails on Redis errors — a missed
// invalidation is worse than an elevated error rate for logged-in
// users (they'll see stale data for ≤ 15 minutes).
func (s *Server) invalidatePortfolioHistoryCache(ctx context.Context, userID int) {
	if s.redisRepo == nil {
		return
	}
	pattern := fmt.Sprintf("portfolio:history:%d:*", userID)
	if err := s.redisRepo.InvalidatePattern(ctx, pattern); err != nil {
		LoggerFromCtx(ctx).Warn("portfolio history cache invalidate failed", "error", err, "user_id", userID)
	}
}

// HandleGetPortfolioHistory returns the user's portfolio value over
// time, reconstructed from QuestDB closes. The algorithm:
//
//  1. Check Redis for a cached response keyed by (userID, window);
//     return those bytes verbatim on hit.
//  2. Load holdings; bail early with an empty curve if there are none.
//  3. Fetch daily OHLC for every symbol the user owns in one batch call.
//  4. Build a forward-filled price map per symbol so days a thinly-traded
//     name doesn't print still carry its last known close.
//  5. Walk the sorted union of trading dates and sum quantity × forward-
//     filled close for every holding owned on that date (purchase_date
//     ≤ trading date).
//  6. Cache the marshaled response for portfolioHistoryCacheTTL before
//     writing it to the client.
//
// The reconstruction step is O(dates × holdings) and dominated by the
// QuestDB batch fetch — caching turns the hot dashboard path into a
// single Redis GET for the 99% case where holdings haven't changed.
func (s *Server) HandleGetPortfolioHistory(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if s.qdbRepo == nil {
		respondError(w, http.StatusServiceUnavailable, "market data unavailable")
		return
	}

	window := strings.TrimSpace(r.URL.Query().Get("window"))
	if window == "" {
		window = "30d"
	}
	startDate, ok := portfolioWindow(window, time.Now())
	if !ok {
		respondError(w, http.StatusBadRequest, "invalid window (use 30d, 90d, ytd, 1y, or all)")
		return
	}

	// Fast path: serve the cached response bytes if present. Hit
	// rate is high because the dashboard re-fetches the same window
	// on every load and holdings change rarely. Miss falls through
	// to the reconstruction below.
	cacheKey := portfolioHistoryCacheKey(user.ID, window)
	if s.redisRepo != nil {
		if cached, err := s.redisRepo.Get(r.Context(), cacheKey); err == nil && len(cached) > 0 {
			w.Header().Set("Content-Type", "application/json")
			w.Write(cached)
			return
		}
	}

	// Singleflight: collapse concurrent identical reconstructions for
	// the same (user, window) pair into one in-flight job. Without
	// this, a client spamming ?window=all (dashboard reload, broken
	// retry loop) re-runs the O(dates × holdings) reconstruction on
	// every request because the cache write happens after the
	// response is already on the wire — by the time hit #2 arrives,
	// hit #1's Redis write may not have landed. The leader does the
	// reconstruction + cache write; waiters reuse the leader's
	// payload bytes verbatim.
	//
	// The reconstruction runs under s.bgCtx, NOT the leader's
	// r.Context(). If we used the request context, a leader who
	// disconnected (or whose r.Context() was the first to fire its
	// .Done() in the select below) would propagate cancellation into
	// the singleflight goroutine — aborting the QuestDB/Postgres
	// queries and handing every waiter a `context canceled` error
	// instead of the result they were waiting for. bgCtx is the
	// server-lifetime context; Shutdown still cancels it cleanly.
	sfKey := fmt.Sprintf("portfolio-history:%d:%s", user.ID, window)
	resCh := s.portfolioHistoryGroup.DoChan(sfKey, func() (interface{}, error) {
		return s.reconstructPortfolioHistory(s.bgCtx, user.ID, window, startDate, cacheKey)
	})
	var payload []byte
	select {
	case res := <-resCh:
		if res.Err != nil {
			// Status was already chosen by the reconstruction helper
			// — the err carries the HTTP code via portfolioHistoryError.
			var phErr *portfolioHistoryError
			if errors.As(res.Err, &phErr) {
				respondError(w, phErr.status, phErr.message)
				return
			}
			respondError(w, http.StatusInternalServerError, "failed to load portfolio history")
			return
		}
		payload, _ = res.Val.([]byte)
	case <-r.Context().Done():
		// Caller bailed (closed connection, timeout). The reconstruction
		// keeps running under s.bgCtx so its result still lands in the
		// Redis cache for the next caller, and any waiters on resCh
		// still get their payload.
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

// portfolioHistoryError carries an HTTP status alongside the message so
// the singleflight closure can communicate "respond 500 vs 503" back to
// the handler. Leader and followers both unwrap this to call respondError
// with the same status.
type portfolioHistoryError struct {
	status  int
	message string
}

func (e *portfolioHistoryError) Error() string { return e.message }

// reconstructPortfolioHistory runs the heavy O(dates × holdings) loop
// and returns the marshaled response bytes. Designed to be called from
// inside singleflight.Group.DoChan so concurrent identical requests
// share one execution. Side-effects (cache write) happen exactly once
// per leader run.
func (s *Server) reconstructPortfolioHistory(ctx context.Context, userID int, window string, startDate time.Time, cacheKey string) ([]byte, error) {
	holdings, err := s.pgRepo.ListPortfolioHoldings(ctx, userID)
	if err != nil {
		return nil, &portfolioHistoryError{http.StatusInternalServerError, "failed to load portfolio"}
	}
	if len(holdings) == 0 {
		empty, _ := json.Marshal(PortfolioHistoryResponse{Window: window, Points: []PortfolioHistoryPoint{}})
		return empty, nil
	}

	// Unique symbol set for the batch fetch.
	symbolSet := make(map[string]struct{}, len(holdings))
	for _, h := range holdings {
		symbolSet[h.Symbol] = struct{}{}
	}
	symbols := make([]string, 0, len(symbolSet))
	for sym := range symbolSet {
		symbols = append(symbols, sym)
	}

	// Compute the user's earliest purchase date up-front so we can
	// pass it as a lower bound to the OHLC query. Symbols with years
	// of history that predate the user's entry (common for long-
	// listed names) would otherwise pull decades of bars only to be
	// thrown away during reconstruction.
	earliestPurchase := ""
	for _, h := range holdings {
		if earliestPurchase == "" || h.PurchaseDate < earliestPurchase {
			earliestPurchase = h.PurchaseDate
		}
	}
	var ohlcSince time.Time
	if earliestPurchase != "" {
		if t, err := time.Parse("2006-01-02", earliestPurchase); err == nil {
			ohlcSince = t
		}
	}

	ohlcBySymbol, err := s.qdbRepo.GetOHLCBatch(ctx, symbols, "1d", ohlcSince)
	if err != nil {
		LoggerFromCtx(ctx).Error("portfolio history: ohlc batch failed", "error", err)
		return nil, &portfolioHistoryError{http.StatusInternalServerError, "failed to load price history"}
	}

	// Build per-symbol lookup: ISO date → close. OHLC rows arrive sorted
	// ASC by trading_date so forward-fill is a single left-to-right pass
	// over the union of dates handled later.
	type symbolSeries struct {
		closesByDate map[string]float64
		sortedDates  []string // ascending
	}
	series := make(map[string]symbolSeries, len(symbols))
	allDates := make(map[string]struct{})
	for sym, bars := range ohlcBySymbol {
		sd := symbolSeries{closesByDate: make(map[string]float64, len(bars)), sortedDates: make([]string, 0, len(bars))}
		for _, b := range bars {
			iso := b.TradingDate.UTC().Format("2006-01-02")
			sd.closesByDate[iso] = b.Close
			sd.sortedDates = append(sd.sortedDates, iso)
			allDates[iso] = struct{}{}
		}
		series[sym] = sd
	}

	// Extend the date axis back to the earliest purchase_date across
	// all holdings. Without this the chart starts at the first OHLC
	// print we have for any symbol — which can be years after the
	// user's actual entry date, producing a curve that misleadingly
	// begins in 2025 when they bought in 2016. For pre-OHLC dates
	// we'll fall back to cost_basis as the per-share price in the
	// value loop below, giving a flat 0% ROI until market data
	// begins; this is the "best we can do without historical data"
	// approach that still shows the holding at book value.
	// earliestPurchase was computed up-front so we could pass it as
	// the OHLC lower bound; reuse the already-parsed ohlcSince time
	// to extend the date axis.
	if !ohlcSince.IsZero() {
		endT := time.Now().UTC()
		for d := ohlcSince; !d.After(endT); d = d.AddDate(0, 0, 1) {
			// Skip Sat/Sun so the x-axis only carries weekdays;
			// otherwise the chart would draw a bar on every
			// calendar day and the pre-OHLC stretch would be
			// unreadably dense.
			wd := d.Weekday()
			if wd == time.Saturday || wd == time.Sunday {
				continue
			}
			allDates[d.Format("2006-01-02")] = struct{}{}
		}
	}

	// Sort the union of trading dates ascending.
	dates := make([]string, 0, len(allDates))
	for d := range allDates {
		dates = append(dates, d)
	}
	sort.Strings(dates)

	// Per-symbol cursors replace the old "build a date→price map per
	// symbol" forward-fill pass. Each cursor walks its own sortedDates
	// in lockstep with the main date loop below, so we never materialise
	// the N_symbols × N_dates lookup table. For a 20-symbol / 5-year
	// portfolio that's ~25k map writes (+ associated GC) avoided per
	// uncached history rebuild.
	type symCursor struct {
		sortedDates  []string
		closesByDate map[string]float64
		idx          int     // next index in sortedDates to examine
		last         float64 // most recent positive close seen; 0 = pre-OHLC
		firstToday   bool    // this iteration crossed 0 → positive (OHLC-transition marker)
	}
	cursors := make(map[string]*symCursor, len(series))
	for sym, sd := range series {
		cursors[sym] = &symCursor{sortedDates: sd.sortedDates, closesByDate: sd.closesByDate}
	}

	// Walk dates and reconstruct the portfolio value curve as true
	// net-asset-value (NAV) per day: only holdings the user actually
	// owned on date `d` contribute. A holding bought after `d` isn't
	// in the sum, so the curve steps up on the day each new position
	// is added. That's the honest total value of the portfolio over
	// time; the daily Δ-ROI performance mode handles those cost-basis
	// additions without treating them as returns.
	startISO := ""
	if !startDate.IsZero() {
		startISO = startDate.Format("2006-01-02")
	}
	// Sort holdings by purchase date so the daily loop can advance a
	// single cursor past "already owned" holdings instead of
	// re-checking every holding's purchase date on every trading day.
	// For a portfolio that grew over time (100 holdings accumulated
	// over 3 years), this turns O(dates × holdings) into roughly
	// O(dates + holdings).
	sortedHoldings := make([]repository.PortfolioHolding, len(holdings))
	copy(sortedHoldings, holdings)
	sort.Slice(sortedHoldings, func(i, j int) bool {
		return sortedHoldings[i].PurchaseDate < sortedHoldings[j].PurchaseDate
	})
	ownedCount := 0
	points := make([]PortfolioHistoryPoint, 0, len(dates))
	for _, d := range dates {
		// Advance the ownership cursor before any date-range skip so
		// ownedCount stays accurate when we enter the window.
		// newlyOwnedStart captures the range of holdings that entered
		// the portfolio *this iteration* — i.e., whose purchase_date
		// falls in (previous d, current d]. Using this instead of
		// `h.PurchaseDate == d` correctly books cashflows for
		// purchases on non-trading days (Saturday/Sunday/holidays),
		// where the string-equality check would never match because
		// the dates loop only emits weekdays.
		newlyOwnedStart := ownedCount
		for ownedCount < len(sortedHoldings) && sortedHoldings[ownedCount].PurchaseDate <= d {
			ownedCount++
		}
		// Advance every symbol's OHLC cursor to d. firstToday flips
		// true the single day a symbol crosses from "no positive
		// close yet" to "has a close" — that's the cashflow-worthy
		// transition point for holdings that have been sitting at
		// their cost-basis proxy.
		for _, c := range cursors {
			wasDark := c.last == 0
			for c.idx < len(c.sortedDates) && c.sortedDates[c.idx] <= d {
				if close := c.closesByDate[c.sortedDates[c.idx]]; close > 0 {
					c.last = close
				}
				c.idx++
			}
			c.firstToday = wasDark && c.last > 0
		}
		if startISO != "" && d < startISO {
			continue
		}
		// Skip dates before any holding was owned — emitting zero-value
		// points there would draw a flat line going back to the first
		// OHLC print in QuestDB (which can predate the user's entry
		// by years). Chart should start at the earliest purchase_date.
		if earliestPurchase != "" && d < earliestPurchase {
			continue
		}
		var value, cashflow float64
		for i := 0; i < ownedCount; i++ {
			h := sortedHoldings[i]
			c := cursors[h.Symbol]
			price := 0.0
			if c != nil {
				price = c.last
			}
			if price == 0 {
				// No OHLC for this symbol on `d` yet (date is before
				// the symbol's earliest market data, or a data gap).
				// Fall back to cost_basis so the holding still
				// registers at book value — value and cost contribute
				// equally, ROI reads as 0% on those dates, and the
				// curve transitions into real prices when OHLC begins.
				price = h.CostBasis
			}
			value += h.Quantity * price
			if i >= newlyOwnedStart {
				// This holding entered the portfolio during this
				// iteration — its purchase_date is in (previous d,
				// current d]. Book today's market value as the
				// cashflow so the client's TWR subtracts it from the
				// day's numerator + denominator and treats the new
				// position as a cash-flow, not a return. Covers both
				// trading-day and non-trading-day purchases; the
				// latter used to fall through silently because
				// `h.PurchaseDate == d` only matched weekday purchases.
				cashflow += h.Quantity * price
			} else if c != nil && c.firstToday {
				// OHLC transition: this holding has been sitting at
				// its book-value proxy (cost_basis) since its
				// purchase_date; today is the first day we have a
				// market price. The jump from cost_basis to close is
				// a data-availability artefact, not a market move —
				// book the delta as a cashflow so TWR treats today's
				// r_i as ~0 rather than charging the whole re-
				// valuation as same-day market return.
				cashflow += h.Quantity * (price - h.CostBasis)
			}
		}
		points = append(points, PortfolioHistoryPoint{
			Date:     d,
			Value:    math.Round(value*100) / 100,
			Cashflow: math.Round(cashflow*100) / 100,
		})
	}

	// Marshal once so we can both cache the bytes and write them to
	// the client — saves a re-marshal on the next hit.
	payload, err := json.Marshal(PortfolioHistoryResponse{
		Window: window,
		Points: points,
	})
	if err != nil {
		return nil, &portfolioHistoryError{http.StatusInternalServerError, "failed to serialise history"}
	}
	// Cache write is kicked off on a tracked background goroutine
	// with a detached context — if the original caller disconnects,
	// the reconstruction we just did still gets saved, and Shutdown
	// can drain in-flight writes before closing the Redis pool.
	if s.redisRepo != nil {
		key := cacheKey
		data := payload
		s.goBackground(func(bgCtx context.Context) {
			writeCtx, cancel := context.WithTimeout(bgCtx, 5*time.Second)
			defer cancel()
			if err := s.redisRepo.SetWithTTL(writeCtx, key, data, portfolioHistoryCacheTTL); err != nil {
				LoggerFromCtx(bgCtx).Debug("portfolio history cache write failed", "error", err)
			}
		})
	}
	return payload, nil
}

// ── CRUD ─────────────────────────────────────────────────────────────

func (s *Server) HandleCreatePortfolioHolding(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var body struct {
		Symbol       string  `json:"symbol"`
		Quantity     float64 `json:"quantity"`
		CostBasis    float64 `json:"costBasis"`
		PurchaseDate string  `json:"purchaseDate"` // YYYY-MM-DD
		Notes        string  `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.Symbol = strings.ToUpper(strings.TrimSpace(body.Symbol))
	if body.Symbol == "" || body.Quantity <= 0 || body.CostBasis < 0 || body.PurchaseDate == "" {
		respondError(w, http.StatusBadRequest, "symbol, quantity (>0), costBasis (>=0), and purchaseDate are required")
		return
	}
	if !validateSymbol(body.Symbol) {
		respondError(w, http.StatusBadRequest, "invalid symbol")
		return
	}
	// Validate date format before passing to Postgres — prevents a raw
	// "invalid input syntax for type date" error from leaking through.
	purchaseT, err := time.Parse("2006-01-02", body.PurchaseDate)
	if err != nil {
		respondError(w, http.StatusBadRequest, "purchaseDate must be in YYYY-MM-DD format")
		return
	}
	// Bound the date to a sane trading window. Without this, a user
	// who enters "1990-01-01" forces HandleGetPortfolioHistory to walk
	// ~9000 weekdays per request × O(holdings), at which point the
	// reconstruction takes seconds and is then cached — a self-inflicted
	// DoS that also pollutes the chart with a decade of pre-listing
	// flatline. The lower bound matches the QuestDB equities horizon
	// (the GSE's modern electronic record begins well after 2000); the
	// upper bound forbids future-dated purchases which would also break
	// reconstruction by booking cashflows after the loop's end date.
	minDate := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	maxDate := time.Now().UTC().AddDate(0, 0, 1)
	if purchaseT.Before(minDate) || purchaseT.After(maxDate) {
		respondError(w, http.StatusBadRequest, "purchaseDate must be between 2000-01-01 and today")
		return
	}

	id, err := s.pgRepo.CreatePortfolioHolding(r.Context(), user.ID, body.Symbol, body.Quantity, body.CostBasis, body.PurchaseDate, body.Notes)
	if err != nil {
		LoggerFromCtx(r.Context()).Error("create portfolio holding failed", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to create holding")
		return
	}
	s.invalidatePortfolioHistoryCache(r.Context(), user.ID)
	respondJSON(w, map[string]interface{}{"id": id, "status": "created"})
}

func (s *Server) HandleUpdatePortfolioHolding(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	holdingID, err := strconv.Atoi(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid holding id")
		return
	}

	var body struct {
		Quantity  float64 `json:"quantity"`
		CostBasis float64 `json:"costBasis"`
		Notes     string  `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Quantity <= 0 {
		respondError(w, http.StatusBadRequest, "quantity must be > 0")
		return
	}

	if err := s.pgRepo.UpdatePortfolioHolding(r.Context(), user.ID, holdingID, body.Quantity, body.CostBasis, body.Notes); err != nil {
		respondError(w, http.StatusNotFound, "holding not found")
		return
	}
	s.invalidatePortfolioHistoryCache(r.Context(), user.ID)
	respondJSON(w, map[string]string{"status": "updated"})
}

func (s *Server) HandleDeletePortfolioHolding(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	holdingID, err := strconv.Atoi(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid holding id")
		return
	}
	if err := s.pgRepo.DeletePortfolioHolding(r.Context(), user.ID, holdingID); err != nil {
		respondError(w, http.StatusNotFound, "holding not found")
		return
	}
	s.invalidatePortfolioHistoryCache(r.Context(), user.ID)
	respondJSON(w, map[string]string{"status": "deleted"})
}
