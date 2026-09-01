package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

func (s *Server) HandleGetWatchList(w http.ResponseWriter, r *http.Request) {
	userIDVal := r.Context().Value(auth.UserIDKey)
	if userIDVal == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"symbols": []string{}, "details": []repository.MarketSummaryItem{}})
		return
	}
	userID := userIDVal.(int)

	watchlist, err := s.pgRepo.GetWatchlistList(r.Context(), userID)
	if err != nil {
		http.Error(w, "Failed to get watchlist", http.StatusInternalServerError)
		return
	}

	items, err := s.cachedMarketSummaryItems(r.Context())
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"symbols": watchlist, "details": []repository.MarketSummaryItem{}})
		return
	}

	wMap := make(map[string]bool)
	for _, sym := range watchlist {
		wMap[sym] = true
	}

	var details []repository.MarketSummaryItem
	for _, item := range items {
		if wMap[item.Symbol] {
			details = append(details, item)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"symbols": watchlist,
		"details": details,
	})
}

func (s *Server) HandleToggleWatchList(w http.ResponseWriter, r *http.Request) {
	userIDVal := r.Context().Value(auth.UserIDKey)
	if userIDVal == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	userID := userIDVal.(int)

	symbol := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("symbol")))
	if symbol == "" {
		http.Error(w, "Missing symbol", http.StatusBadRequest)
		return
	}
	if !validateSymbol(symbol) {
		respondError(w, http.StatusBadRequest, "Invalid symbol")
		return
	}

	added, err := s.pgRepo.ToggleWatchlist(r.Context(), userID, symbol)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"isWatchlisted": added})
}
