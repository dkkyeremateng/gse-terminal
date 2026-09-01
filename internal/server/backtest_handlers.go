package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/analysis"
)

// HandleBacktest runs a deterministic technical backtest over the full
// OHLC history for a symbol, returning signal-by-signal results plus
// aggregate stats (win rate, Sharpe, max drawdown). Pro/Admin gated at
// the router level; the handler itself doesn't re-check.
//
// Query params:
//   - symbol (required) — e.g. MTNGH
//
// No caching — the response is computed on demand and varies with the
// live data set. Each call costs one QuestDB OHLC query + O(N) compute
// in Go; N is typically 60–250 bars so latency is <50ms.
func (s *Server) HandleBacktest(w http.ResponseWriter, r *http.Request) {
	if s.qdbRepo == nil {
		respondError(w, http.StatusServiceUnavailable, "Market data service unavailable")
		return
	}

	symbol := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("symbol")))
	if symbol == "" {
		respondError(w, http.StatusBadRequest, "Missing symbol")
		return
	}
	if !validateSymbol(symbol) {
		respondError(w, http.StatusBadRequest, "Invalid symbol")
		return
	}

	// Cap the backtest at 30s so a slow QuestDB query on a large
	// prod table doesn't hold the connection indefinitely.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	bt := analysis.NewBacktestService(s.qdbRepo)
	result, err := bt.Run(ctx, symbol, nil)
	if err != nil {
		LoggerFromCtx(r.Context()).Warn("backtest failed", "symbol", symbol, "error", err)
		respondError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	respondJSON(w, result)
}
