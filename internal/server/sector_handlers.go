package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// SectorPerformance is the JSON shape returned by /v1/market-sectors. It's
// produced by aggregateSectorPerformance from the latest market snapshot and
// optionally trimmed via ?detail=summary to drop the constituents list.
type SectorPerformance struct {
	Sector        string                         `json:"sector"`
	AvgPctChange  float64                        `json:"avgPctChange"`
	TotalVolume   int64                          `json:"totalVolume"`
	TotalTurnover float64                        `json:"totalTurnover"`
	DeclineCount  int                            `json:"declineCount"`
	AdvanceCount  int                            `json:"advanceCount"`
	NeutralCount  int                            `json:"neutralCount"`
	TopGainer     repository.MarketSummaryItem   `json:"topGainer"`
	WorstLoser    repository.MarketSummaryItem   `json:"worstLoser"`
	Constituents  []repository.MarketSummaryItem `json:"constituents,omitempty"`
}

// aggregateSectorPerformance is the pure aggregation function exposed for
// testing. It groups items by sector, computes turnover-weighted average %
// change (falling back to equal-weighted when turnover is zero), counts
// breadth, and picks deterministic top gainer / worst loser (tie-broken by
// symbol so the result is stable).
func aggregateSectorPerformance(items []repository.MarketSummaryItem) []SectorPerformance {
	sectorMap := make(map[string]*SectorPerformance)
	weightedNum := make(map[string]float64) // Σ(pct * turnover)
	weightedDen := make(map[string]float64) // Σ(turnover)
	equalSum := make(map[string]float64)    // fallback Σ(pct)

	for _, item := range items {
		if item.Symbol == "" || item.LastPrice <= 0 {
			continue
		}
		sectorName := repository.GetSector(item.Symbol)
		perf, ok := sectorMap[sectorName]
		if !ok {
			perf = &SectorPerformance{Sector: sectorName}
			sectorMap[sectorName] = perf
		}

		turnover := float64(item.Volume) * item.LastPrice
		perf.TotalVolume += item.Volume
		perf.TotalTurnover += turnover
		perf.Constituents = append(perf.Constituents, item)

		weightedNum[sectorName] += item.PercentChange * turnover
		weightedDen[sectorName] += turnover
		equalSum[sectorName] += item.PercentChange

		switch {
		case item.PercentChange > 0:
			perf.AdvanceCount++
		case item.PercentChange < 0:
			perf.DeclineCount++
		default:
			perf.NeutralCount++
		}

		// Top gainer: higher %, ties broken by symbol asc for determinism.
		if perf.TopGainer.Symbol == "" ||
			item.PercentChange > perf.TopGainer.PercentChange ||
			(item.PercentChange == perf.TopGainer.PercentChange && item.Symbol < perf.TopGainer.Symbol) {
			perf.TopGainer = item
		}
		// Worst loser: lower %, ties broken by symbol asc.
		if perf.WorstLoser.Symbol == "" ||
			item.PercentChange < perf.WorstLoser.PercentChange ||
			(item.PercentChange == perf.WorstLoser.PercentChange && item.Symbol < perf.WorstLoser.Symbol) {
			perf.WorstLoser = item
		}
	}

	result := make([]SectorPerformance, 0, len(sectorMap))
	for name, perf := range sectorMap {
		count := len(perf.Constituents)
		if weightedDen[name] > 0 {
			perf.AvgPctChange = weightedNum[name] / weightedDen[name]
		} else if count > 0 {
			perf.AvgPctChange = equalSum[name] / float64(count)
		}
		// Stable constituent ordering for ETag friendliness.
		sort.Slice(perf.Constituents, func(i, j int) bool {
			return perf.Constituents[i].Symbol < perf.Constituents[j].Symbol
		})
		result = append(result, *perf)
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].AvgPctChange != result[j].AvgPctChange {
			return result[i].AvgPctChange > result[j].AvgPctChange
		}
		return result[i].Sector < result[j].Sector
	})
	return result
}

// SectorOverview is the slim public-tier shape — no constituents, no
// per-sector top gainer/loser. Just enough to render a heatmap tile
// (name, today's avg %, breadth) without leaking the full breakdown
// reserved for /v1/market-sectors (Pro/Admin).
type SectorOverview struct {
	Sector       string  `json:"sector"`
	AvgPctChange float64 `json:"avgPctChange"`
	AdvanceCount int     `json:"advanceCount"`
	DeclineCount int     `json:"declineCount"`
	NeutralCount int     `json:"neutralCount"`
}

// HandleGetMarketSectorsOverview returns the public, breadth-only sector
// view used by the dashboard's heatmap tile. Backed by the same cached
// market snapshot as the Pro endpoint but never returns constituents or
// per-sector leader symbols.
func (s *Server) HandleGetMarketSectorsOverview(w http.ResponseWriter, r *http.Request) {
	bytes, err := s.cachedJSONBytes(r.Context(), "gse:data:market-sectors:overview", func() (interface{}, error) {
		items, err := s.cachedMarketSummaryItems(r.Context())
		if err != nil {
			return nil, err
		}
		full := aggregateSectorPerformance(items)
		out := make([]SectorOverview, 0, len(full))
		for _, p := range full {
			out = append(out, SectorOverview{
				Sector:       p.Sector,
				AvgPctChange: p.AvgPctChange,
				AdvanceCount: p.AdvanceCount,
				DeclineCount: p.DeclineCount,
				NeutralCount: p.NeutralCount,
			})
		}
		return out, nil
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to compute sector overview")
		return
	}
	writeCachedJSON(w, bytes)
}

func (s *Server) HandleGetMarketSectors(w http.ResponseWriter, r *http.Request) {
	bytes, err := s.cachedJSONBytes(r.Context(), "gse:data:market-sectors", func() (interface{}, error) {
		items, err := s.cachedMarketSummaryItems(r.Context())
		if err != nil {
			return nil, err
		}
		return aggregateSectorPerformance(items), nil
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to compute sector data")
		return
	}

	// ?detail=summary strips constituents to shrink payload by ~70% for the
	// default dashboard render. Drill-down requests omit the param.
	if r.URL.Query().Get("detail") == "summary" {
		var sectors []SectorPerformance
		if err := json.Unmarshal(bytes, &sectors); err == nil {
			for i := range sectors {
				sectors[i].Constituents = nil
			}
			if trimmed, err := json.Marshal(sectors); err == nil {
				bytes = trimmed
			}
		}
	}
	writeCachedJSON(w, bytes)
}

// SectorHistoryPoint is a single (sector, date, indexed-value) sample for the
// rotation chart. The index is rebased to 100 at the start of the requested
// window so sectors with very different absolute price levels can be
// overlaid meaningfully.
type SectorHistoryPoint struct {
	Date  time.Time `json:"date"`
	Value float64   `json:"value"`
}

type SectorHistorySeries struct {
	Sector string               `json:"sector"`
	Series []SectorHistoryPoint `json:"series"`
}

func (s *Server) HandleGetMarketSectorsHistory(w http.ResponseWriter, r *http.Request) {
	rangeStr := r.URL.Query().Get("range")
	days := 30
	switch rangeStr {
	case "1W":
		days = 7
	case "1M":
		days = 30
	case "3M":
		days = 90
	case "6M":
		days = 180
	case "1Y":
		days = 365
	}

	cacheKey := fmt.Sprintf("gse:data:market-sectors-history:%d", days)
	bytes, err := s.cachedJSONBytes(r.Context(), cacheKey, func() (interface{}, error) {
		rows, err := s.qdbRepo.GetDailyClosesAllSymbols(r.Context(), days)
		if err != nil {
			return nil, err
		}
		return buildSectorRotation(rows), nil
	})
	if err != nil {
		LoggerFromCtx(r.Context()).Error("Sector history error", "error", err)
		respondError(w, http.StatusInternalServerError, "Failed to compute sector history")
		return
	}
	writeCachedJSON(w, bytes)
}

// buildSectorRotation transforms (date, symbol, close) rows into per-sector
// equal-weighted indexed series rebased to 100 at the first observed date
// for each constituent. Days are inserted in chronological order.
func buildSectorRotation(rows []repository.SymbolDailyClose) []SectorHistorySeries {
	type bucket struct {
		sum   float64
		count int
	}
	type dayMap map[time.Time]*bucket

	// First pass: per-symbol baseline (first close in window)
	baseline := make(map[string]float64)
	for _, row := range rows {
		if _, ok := baseline[row.Symbol]; !ok && row.Close > 0 {
			baseline[row.Symbol] = row.Close
		}
	}

	sectors := make(map[string]dayMap)
	for _, row := range rows {
		if row.Close <= 0 {
			continue
		}
		base := baseline[row.Symbol]
		if base <= 0 {
			continue
		}
		sec := repository.GetSector(row.Symbol)
		if _, ok := sectors[sec]; !ok {
			sectors[sec] = dayMap{}
		}
		day := row.Date.Truncate(24 * time.Hour)
		b, ok := sectors[sec][day]
		if !ok {
			b = &bucket{}
			sectors[sec][day] = b
		}
		b.sum += (row.Close / base) * 100.0
		b.count++
	}

	out := make([]SectorHistorySeries, 0, len(sectors))
	for name, days := range sectors {
		series := make([]SectorHistoryPoint, 0, len(days))
		for d, b := range days {
			if b.count == 0 {
				continue
			}
			series = append(series, SectorHistoryPoint{Date: d, Value: b.sum / float64(b.count)})
		}
		sort.Slice(series, func(i, j int) bool { return series[i].Date.Before(series[j].Date) })
		out = append(out, SectorHistorySeries{Sector: name, Series: series})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Sector < out[j].Sector })
	return out
}

// ─── Admin: sector overrides ────────────────────────────────────────────────

type sectorOverrideResp struct {
	Symbol string `json:"symbol"`
	Sector string `json:"sector"`
	Source string `json:"source"` // "override" or "seed"
}

func (s *Server) HandleAdminListSectors(w http.ResponseWriter, r *http.Request) {
	overrides, err := s.pgRepo.ListSectorOverrides(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to load sector overrides")
		return
	}
	overrideSet := make(map[string]bool, len(overrides))
	for k := range overrides {
		overrideSet[k] = true
	}
	merged := repository.AllSectorMappings()
	out := make([]sectorOverrideResp, 0, len(merged))
	for sym, sec := range merged {
		src := "seed"
		if overrideSet[sym] {
			src = "override"
		}
		out = append(out, sectorOverrideResp{Symbol: sym, Sector: sec, Source: src})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Symbol < out[j].Symbol })
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

type sectorUpsertReq struct {
	Symbol string `json:"symbol"`
	Sector string `json:"sector"`
}

func (s *Server) HandleAdminUpsertSector(w http.ResponseWriter, r *http.Request) {
	// Bounded body — the payload is two short strings; 4 KiB is generous.
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req sectorUpsertReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}
	req.Symbol = strings.ToUpper(strings.TrimSpace(req.Symbol))
	req.Sector = strings.TrimSpace(req.Sector)
	if req.Symbol == "" || req.Sector == "" {
		respondError(w, http.StatusBadRequest, "symbol and sector required")
		return
	}
	if !validateSymbol(req.Symbol) {
		respondError(w, http.StatusBadRequest, "invalid symbol")
		return
	}
	// Length-cap matches the sector_overrides.sector column (VARCHAR(64))
	// so we surface a clean 400 instead of a Postgres "value too long"
	// error, and we refuse runs of whitespace/control chars that would
	// otherwise flow into aggregateSectorPerformance map keys.
	if len(req.Sector) > 64 {
		respondError(w, http.StatusBadRequest, "sector must be 64 characters or fewer")
		return
	}
	if err := s.pgRepo.UpsertSectorOverride(r.Context(), req.Symbol, req.Sector); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to save override")
		return
	}
	repository.SetSectorOverride(req.Symbol, req.Sector)
	// Cache invalidation is detached from the request so the admin's
	// PUT returns immediately, but tracked via goBackground so Shutdown
	// can wait for the pattern scan to finish before tearing down Redis.
	s.goBackground(func(bgCtx context.Context) {
		s.redisRepo.InvalidatePattern(bgCtx, "gse:data:market-sectors*")
	})

	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), "sector.upsert", "symbol", req.Symbol, map[string]interface{}{"sector": req.Sector})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) HandleAdminDeleteSector(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(chi.URLParam(r, "symbol"))
	if symbol == "" {
		respondError(w, http.StatusBadRequest, "symbol required")
		return
	}
	if err := s.pgRepo.DeleteSectorOverride(r.Context(), symbol); err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to delete override")
		return
	}
	repository.DeleteSectorOverride(symbol)
	s.goBackground(func(bgCtx context.Context) {
		s.redisRepo.InvalidatePattern(bgCtx, "gse:data:market-sectors*")
	})

	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), "sector.delete", "symbol", symbol, nil)
	}
	w.WriteHeader(http.StatusNoContent)
}
