package server

import (
	"math"
	"testing"

	"github.com/teckdroids/ges-data-engine/internal/repository"
)

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestAggregateSectorPerformance(t *testing.T) {
	// Use built-in seed: GCB→Banking, MTNGH→Telecommunications, SCB→Banking
	items := []repository.MarketSummaryItem{
		{Symbol: "GCB", LastPrice: 10, Volume: 1000, PercentChange: 4.0},  // turnover 10000
		{Symbol: "SCB", LastPrice: 20, Volume: 100, PercentChange: -2.0},  // turnover 2000
		{Symbol: "MTNGH", LastPrice: 5, Volume: 5000, PercentChange: 1.5}, // turnover 25000
		{Symbol: "ZERO", LastPrice: 0, Volume: 1000, PercentChange: 99},   // skipped (no price)
		{Symbol: "", LastPrice: 1, Volume: 1, PercentChange: 0},           // skipped (no symbol)
	}

	got := aggregateSectorPerformance(items)

	byName := map[string]SectorPerformance{}
	for _, s := range got {
		byName[s.Sector] = s
	}

	bank, ok := byName["Banking"]
	if !ok {
		t.Fatalf("expected Banking sector in result")
	}
	// Turnover-weighted: (4*10000 + -2*2000) / (10000+2000) = 36000/12000 = 3.0
	if !approx(bank.AvgPctChange, 3.0) {
		t.Errorf("Banking avg = %v, want 3.0", bank.AvgPctChange)
	}
	if bank.AdvanceCount != 1 || bank.DeclineCount != 1 || bank.NeutralCount != 0 {
		t.Errorf("Banking breadth = %d/%d/%d, want 1/1/0", bank.AdvanceCount, bank.DeclineCount, bank.NeutralCount)
	}
	if bank.TopGainer.Symbol != "GCB" {
		t.Errorf("Banking top gainer = %q, want GCB", bank.TopGainer.Symbol)
	}
	if bank.WorstLoser.Symbol != "SCB" {
		t.Errorf("Banking worst loser = %q, want SCB", bank.WorstLoser.Symbol)
	}
	if bank.TotalVolume != 1100 {
		t.Errorf("Banking volume = %d, want 1100", bank.TotalVolume)
	}
	if !approx(bank.TotalTurnover, 12000) {
		t.Errorf("Banking turnover = %v, want 12000", bank.TotalTurnover)
	}
	if len(bank.Constituents) != 2 {
		t.Errorf("Banking constituents = %d, want 2", len(bank.Constituents))
	}
	// Constituents must be sorted by symbol for stable output
	if bank.Constituents[0].Symbol != "GCB" || bank.Constituents[1].Symbol != "SCB" {
		t.Errorf("Banking constituents not sorted by symbol: %v", bank.Constituents)
	}

	telco, ok := byName["Telecommunications"]
	if !ok {
		t.Fatalf("expected Telecommunications sector")
	}
	if !approx(telco.AvgPctChange, 1.5) {
		t.Errorf("Telco avg = %v, want 1.5", telco.AvgPctChange)
	}

	// Sort order: Banking (3.0) before Telco (1.5)
	if got[0].Sector != "Banking" {
		t.Errorf("first sector = %q, want Banking", got[0].Sector)
	}
}

func TestAggregateSectorTopGainerTiebreak(t *testing.T) {
	// Two banking stocks with identical % change → must pick lower symbol asc.
	items := []repository.MarketSummaryItem{
		{Symbol: "SCB", LastPrice: 1, Volume: 1, PercentChange: 5.0},
		{Symbol: "GCB", LastPrice: 1, Volume: 1, PercentChange: 5.0},
	}
	got := aggregateSectorPerformance(items)
	if got[0].TopGainer.Symbol != "GCB" {
		t.Errorf("tiebreak failed: top gainer = %q, want GCB", got[0].TopGainer.Symbol)
	}
}

func TestAggregateSectorEqualWeightFallback(t *testing.T) {
	// Zero volume → equal-weighted average kicks in.
	items := []repository.MarketSummaryItem{
		{Symbol: "GCB", LastPrice: 10, Volume: 0, PercentChange: 6.0},
		{Symbol: "SCB", LastPrice: 20, Volume: 0, PercentChange: 2.0},
	}
	got := aggregateSectorPerformance(items)
	if !approx(got[0].AvgPctChange, 4.0) {
		t.Errorf("equal-weight avg = %v, want 4.0", got[0].AvgPctChange)
	}
}
