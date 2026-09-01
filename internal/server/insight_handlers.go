package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/analysis"
)

// aiInsightCacheTTL is how long a generated Gemini insight stays
// cached. 12h is twice the typical user-browsing session and survives
// the daily scrape cycle — crucially, the cache key lives under the
// `gse:llm:*` prefix (not `gse:data:*`) so scrape's pattern-bust
// doesn't wipe it and force a burst of Gemini re-fetches against the
// free-tier RPM cap. Admin CSV uploads can invalidate the namespace
// explicitly when pricing actually changed.
const aiInsightCacheTTL = 12 * time.Hour

// HandleGetAIInsight is a thin transport-layer wrapper around
// analysis.InsightService. It handles caching, request validation, and
// HTTP/JSON encoding only — all the heavy lifting (LLM call, technicals,
// sentiment) lives in the analysis package.
func (s *Server) HandleGetAIInsight(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("symbol")))
	if symbol == "" {
		respondError(w, http.StatusBadRequest, "Missing symbol")
		return
	}
	if !validateSymbol(symbol) {
		respondError(w, http.StatusBadRequest, "Invalid symbol")
		return
	}

	key := fmt.Sprintf("gse:llm:ai-insight:%s", symbol)
	bytes, err := s.cachedJSONBytesTTL(r.Context(), key, aiInsightCacheTTL, func() (interface{}, error) {
		insight, gerr := s.insightSvc.Generate(r.Context(), symbol)
		if gerr != nil {
			return nil, gerr
		}
		return insight, nil
	})
	if err != nil {
		if errors.Is(err, analysis.ErrInsufficientData) {
			respondError(w, http.StatusUnprocessableEntity, "Insufficient data for AI modeling")
			return
		}
		LoggerFromCtx(r.Context()).Error("ai insight generation failed", "symbol", symbol, "error", err)
		respondError(w, http.StatusInternalServerError, "Failed to generate insight")
		return
	}
	writeCachedJSON(w, bytes)
}
