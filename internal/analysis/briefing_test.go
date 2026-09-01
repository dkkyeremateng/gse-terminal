package analysis

import (
	"context"
	"strings"
	"testing"
)

func TestRSIVerdict(t *testing.T) {
	tests := []struct {
		name string
		rsi  float64
		want string
	}{
		{name: "zero", rsi: 0, want: "Oversold"},
		{name: "twenty five", rsi: 25, want: "Oversold"},
		{name: "fifty", rsi: 50, want: "Neutral"},
		{name: "seventy five", rsi: 75, want: "Overbought"},
		{name: "hundred", rsi: 100, want: "Extreme overbought"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RSIVerdict(tt.rsi)
			if got != tt.want {
				t.Fatalf("RSIVerdict(%v) = %q, want %q", tt.rsi, got, tt.want)
			}
		})
	}
}

func TestGenerateMarketSummary_InsufficientData(t *testing.T) {
	svc := NewBriefingService(nil, nil)
	insights := []*Insight{{Symbol: "AADS", RSI: 100, Signal: "NEUTRAL"}}

	summary, err := svc.GenerateMarketSummary(context.Background(), insights)
	if err != nil {
		t.Fatalf("GenerateMarketSummary returned error: %v", err)
	}
	if summary != insufficientDataSummary {
		t.Fatalf("summary = %q, want %q", summary, insufficientDataSummary)
	}
}

func TestGenerateMarketSummary_FallbackPluralization(t *testing.T) {
	svc := NewBriefingService(nil, nil)
	insights := []*Insight{
		{Symbol: "A", Signal: "BULLISH"},
		{Symbol: "B", Signal: "BEARISH"},
		{Symbol: "C", Signal: "NEUTRAL"},
		{Symbol: "D", Signal: "BULLISH"},
		{Symbol: "E", Signal: "NEUTRAL"},
	}

	summary, err := svc.GenerateMarketSummary(context.Background(), insights)
	if err != nil {
		t.Fatalf("GenerateMarketSummary returned error: %v", err)
	}

	if !strings.Contains(summary, "5 stocks analyzed") {
		t.Fatalf("summary %q does not contain pluralized stock count", summary)
	}
	if !strings.Contains(summary, "2 showed bullish signals") {
		t.Fatalf("summary %q does not contain bullish count", summary)
	}
	if !strings.Contains(summary, "1 showed bearish momentum") {
		t.Fatalf("summary %q does not contain bearish count", summary)
	}
}

func TestStockNoun(t *testing.T) {
	if got := stockNoun(1); got != "stock" {
		t.Fatalf("stockNoun(1) = %q, want stock", got)
	}
	if got := stockNoun(5); got != "stocks" {
		t.Fatalf("stockNoun(5) = %q, want stocks", got)
	}
}

func TestInsightCarriesBriefingVerdict(t *testing.T) {
	insight := &Insight{RSI: 100}
	insight.Verdict = RSIVerdict(insight.RSI)
	if insight.Verdict != "Extreme overbought" {
		t.Fatalf("verdict = %q, want Extreme overbought", insight.Verdict)
	}
}
