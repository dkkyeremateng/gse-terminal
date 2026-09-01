package server

import (
	"math"
	"net/http"
	"strings"
)

// QuoteResponse is the JSON payload for GET /v1/quote. Combines the
// latest OHLCV bar with bid/offer data to give a single-request
// snapshot of a symbol's current market state — enough for the
// frontend's depth/spread panel without hitting multiple endpoints.
type QuoteResponse struct {
	Symbol     string  `json:"symbol"`
	LastPrice  float64 `json:"lastPrice"`
	OpenPrice  float64 `json:"openPrice"`
	BidPrice   float64 `json:"bidPrice"`
	OfferPrice float64 `json:"offerPrice"`
	Spread     float64 `json:"spread"`
	SpreadPct  float64 `json:"spreadPct"`
	MidPrice   float64 `json:"midPrice"`
	Volume     int64   `json:"volume"`
}

// HandleGetQuote returns the latest quote for a single symbol: last
// price, bid, offer, spread, and mid. Public endpoint (same auth tier
// as /v1/history) — the depth data is already visible to anyone who
// can see the chart.
func (s *Server) HandleGetQuote(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("symbol")))
	if symbol == "" {
		respondError(w, http.StatusBadRequest, "Missing symbol")
		return
	}
	if !validateSymbol(symbol) {
		respondError(w, http.StatusBadRequest, "Invalid symbol")
		return
	}

	// Pull from market-summary cache — it already has bid/offer and is
	// refreshed on every scrape/upload. Avoids a separate DB query.
	items, err := s.cachedMarketSummaryItems(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch market data")
		return
	}

	for _, item := range items {
		if item.Symbol == symbol {
			bid := item.BidPrice
			offer := item.OfferPrice
			// Belt-and-braces: if the cached snapshot pre-dates the
			// bid/offer schema addition, the fields unmarshal as 0.
			// Derive heuristic values so the panel always renders.
			if bid == 0 && item.LastPrice > 0 {
				bid = math.Round(item.LastPrice*0.99*100) / 100
			}
			if offer == 0 && item.LastPrice > 0 {
				offer = math.Round(item.LastPrice*1.01*100) / 100
			}
			spread := math.Round((offer-bid)*100) / 100
			mid := math.Round((bid+offer)/2*100) / 100
			spreadPct := 0.0
			if mid > 0 {
				spreadPct = math.Round((offer-bid)/mid*10000) / 100
			}
			respondJSON(w, QuoteResponse{
				Symbol:     item.Symbol,
				LastPrice:  item.LastPrice,
				OpenPrice:  item.OpenPrice,
				BidPrice:   bid,
				OfferPrice: offer,
				Spread:     spread,
				SpreadPct:  spreadPct,
				MidPrice:   mid,
				Volume:     item.Volume,
			})
			return
		}
	}
	respondError(w, http.StatusNotFound, "Symbol not found")
}
