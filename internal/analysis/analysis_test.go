package analysis

import (
	"math"
	"testing"
)

// ── SMA ──────────────────────────────────────────────────────────────────────

func TestCalculateSMA(t *testing.T) {
	tests := []struct {
		name     string
		prices   []float64
		period   int
		expected float64
	}{
		{"Single price", []float64{10.0}, 1, 10.0},
		{"Three prices", []float64{10.0, 20.0, 30.0}, 3, 20.0},
		{"Period larger than data", []float64{10.0, 20.0}, 5, 15.0},
		{"Sub-slice SMA", []float64{100.0, 10.0, 20.0, 30.0}, 3, 20.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SMA(tt.prices, tt.period)
			if got != tt.expected {
				t.Errorf("SMA(%v, %d) = %f; want %f", tt.prices, tt.period, got, tt.expected)
			}
		})
	}
}

// ── Wilder RSI ───────────────────────────────────────────────────────────────

func TestCalculateWilderRSI(t *testing.T) {
	tests := []struct {
		name     string
		prices   []float64
		period   int
		expected float64
	}{
		{"Insufficient data returns 50", []float64{10.0, 11.0}, 14, 50.0},
		{"Steady gains → 100", []float64{10, 11, 12, 13, 14}, 4, 100.0},
		{"Steady losses → 0", []float64{14, 13, 12, 11, 10}, 4, 0.0},
		{"Equal gains and losses → 50", []float64{10, 11, 10, 11, 10}, 4, 50.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := WilderRSI(tt.prices, tt.period)
			if math.Abs(got-tt.expected) > 0.01 {
				t.Errorf("WilderRSI(%v, %d) = %f; want %f", tt.prices, tt.period, got, tt.expected)
			}
		})
	}
}

func TestCalculateWilderRSI_Smoothing(t *testing.T) {
	// With 20 prices of alternating +1/-1, Wilder smoothing should converge near 50
	prices := make([]float64, 21)
	prices[0] = 100
	for i := 1; i <= 20; i++ {
		if i%2 == 0 {
			prices[i] = prices[i-1] - 1
		} else {
			prices[i] = prices[i-1] + 1
		}
	}
	got := WilderRSI(prices, 14)
	if got < 40 || got > 60 {
		t.Errorf("Wilder RSI on alternating series = %f; expected near 50", got)
	}
}

// ── ATR ──────────────────────────────────────────────────────────────────────

func TestCalculateATR(t *testing.T) {
	t.Run("Constant range returns that range", func(t *testing.T) {
		// High=12, Low=10, Close=11 every day → TR = 2.0 always
		n := 20
		highs := make([]float64, n)
		lows := make([]float64, n)
		closes := make([]float64, n)
		for i := range highs {
			highs[i] = 12
			lows[i] = 10
			closes[i] = 11
		}
		got := ATR(highs, lows, closes, 14)
		if math.Abs(got-2.0) > 0.01 {
			t.Errorf("ATR constant range = %f; want 2.0", got)
		}
	})

	t.Run("Insufficient data returns non-negative", func(t *testing.T) {
		got := ATR([]float64{12}, []float64{10}, []float64{11}, 14)
		if got < 0 {
			t.Errorf("ATR with 1 bar = %f; want >= 0", got)
		}
	})

	t.Run("Gap up increases TR above HL range", func(t *testing.T) {
		// prev close=5, today high=10, low=8 → TR = max(2, 5, 3) = 5
		highs := []float64{5, 10}
		lows := []float64{4, 8}
		closes := []float64{5, 9}
		got := ATR(highs, lows, closes, 1)
		if got < 2.0 {
			t.Errorf("ATR gap-up = %f; expected > HL range of 2", got)
		}
	})
}

// ── Average Volume ────────────────────────────────────────────────────────────

func TestCalculateAvgVolume(t *testing.T) {
	tests := []struct {
		name     string
		volumes  []int64
		period   int
		expected int64
	}{
		{"Exact period", []int64{100, 200, 300}, 3, 200},
		{"Period larger than data", []int64{100, 300}, 10, 200},
		{"Uses last N only", []int64{1000, 100, 200, 300}, 3, 200},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := AvgVolume(tt.volumes, tt.period)
			if got != tt.expected {
				t.Errorf("AvgVolume(%v, %d) = %d; want %d", tt.volumes, tt.period, got, tt.expected)
			}
		})
	}
}

// ── Weighted Sentiment ────────────────────────────────────────────────────────

func TestWeightedSentiment(t *testing.T) {
	t.Run("Empty returns 0", func(t *testing.T) {
		got := WeightedSentiment(nil)
		if got != 0 {
			t.Errorf("WeightedSentiment(nil) = %f; want 0", got)
		}
	})

	t.Run("Bullish headline scores positive", func(t *testing.T) {
		items := []Headline{{Title: "MTNGH reports record profit and dividend upgrade"}}
		got := WeightedSentiment(items)
		if got <= 0 {
			t.Errorf("bullish headline scored %f; want > 0", got)
		}
	})

	t.Run("Bearish headline scores negative", func(t *testing.T) {
		items := []Headline{{Title: "ADB faces fraud scandal and default risk"}}
		got := WeightedSentiment(items)
		if got >= 0 {
			t.Errorf("bearish headline scored %f; want < 0", got)
		}
	})

	t.Run("Neutral headline scores near zero", func(t *testing.T) {
		items := []Headline{{Title: "GSE regular trading session resumes today"}}
		got := WeightedSentiment(items)
		if math.Abs(got) > 0.2 {
			t.Errorf("neutral headline scored %f; want near 0", got)
		}
	})

	t.Run("Word boundary: fallout does not match fall", func(t *testing.T) {
		withFallout := []Headline{{Title: "political fallout continues"}}
		withFall := []Headline{{Title: "stock prices fall sharply"}}
		scoreFallout := WeightedSentiment(withFallout)
		scoreFall := WeightedSentiment(withFall)
		if scoreFallout == scoreFall {
			t.Errorf("'fallout' and 'fall' scored identically (%f); word-boundary matching broken", scoreFallout)
		}
		if scoreFallout < 0 {
			t.Errorf("'fallout' incorrectly scored negative (%f); should not match 'fall'", scoreFallout)
		}
	})

	t.Run("Recency: newer items outweigh older", func(t *testing.T) {
		bullishFirst := []Headline{
			{Title: "record profit surge"},   // newest, weight 1.0
			{Title: "fraud scandal default"}, // older, weight 0.85
		}
		bearishFirst := []Headline{
			{Title: "fraud scandal default"}, // newest
			{Title: "record profit surge"},   // older
		}
		bullishScore := WeightedSentiment(bullishFirst)
		bearishScore := WeightedSentiment(bearishFirst)
		if bullishScore <= bearishScore {
			t.Errorf("recency decay not working: bullishFirst=%f bearishFirst=%f; expected bullishFirst > bearishFirst", bullishScore, bearishScore)
		}
	})

	t.Run("Score clamped to [-1, 1]", func(t *testing.T) {
		items := []Headline{{Title: "profit dividend bonus growth surge expand upgrade outperform beat rally record"}}
		got := WeightedSentiment(items)
		if got > 1.0 || got < -1.0 {
			t.Errorf("score %f out of [-1,1] bounds", got)
		}
	})
}

// ── Analyze Sentiment ─────────────────────────────────────────────────────────

func TestAnalyzeSentiment(t *testing.T) {
	tests := []struct {
		name  string
		title string
		min   float64
		max   float64
	}{
		{"Bullish title", "MTNGH reports profit growth and higher dividends", 0.3, 1.0},
		{"Bearish title", "ADB faces loss and debt decline", -1.0, -0.3},
		{"Neutral title", "GSE regular trading session continues", -0.1, 0.1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SimpleSentiment(tt.title)
			if got < tt.min || got > tt.max {
				t.Errorf("SimpleSentiment(%q) = %f; want range [%f, %f]", tt.title, got, tt.min, tt.max)
			}
		})
	}
}

// ── Derive Signal ─────────────────────────────────────────────────────────────

func TestDeriveSignal(t *testing.T) {
	tests := []struct {
		name       string
		rsi        float64
		sentiment  float64
		aboveSMA50 bool
		aboveSMA20 bool
		expected   string
	}{
		// BULLISH: rsi < 40 && sentiment >= 0 && (aboveSMA50 || aboveSMA20)
		{"Oversold + positive + above SMA20", 30.0, 0.5, false, true, "BULLISH"},
		{"Oversold + positive + above SMA50", 35.0, 0.0, true, false, "BULLISH"},
		// BEARISH: various conditions
		{"Overbought in downtrend", 75.0, 0.0, false, false, "BEARISH"},
		{"Negative sentiment + elevated RSI", 60.0, -0.5, true, true, "BEARISH"},
		{"Below SMA50 with high RSI", 66.0, 0.0, false, false, "BEARISH"},
		// BULLISH blocked without trend support
		{"Oversold but below both MAs", 30.0, 0.5, false, false, "NEUTRAL"},
		// NEUTRAL
		{"Neutral RSI, neutral sentiment, uptrend", 50.0, 0.0, true, true, "NEUTRAL"},
		{"RSI 40 boundary (not < 40)", 40.0, 0.5, true, true, "NEUTRAL"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := DeriveSignal(tt.rsi, tt.sentiment, tt.aboveSMA50, tt.aboveSMA20)
			if got != tt.expected {
				t.Errorf("DeriveSignal(rsi=%.1f, sent=%.1f, sma50=%v, sma20=%v) = %s; want %s",
					tt.rsi, tt.sentiment, tt.aboveSMA50, tt.aboveSMA20, got, tt.expected)
			}
		})
	}
}

// ── Confidence ────────────────────────────────────────────────────────────────

func TestCalculateConfidence(t *testing.T) {
	t.Run("Minimum inputs give base score around 50", func(t *testing.T) {
		got := Confidence(50, 0, "NEUTRAL", true, 1.0, 14)
		if got < 50 || got > 70 {
			t.Errorf("baseline confidence = %f; expected 50–70", got)
		}
	})

	t.Run("Large sample boosts confidence", func(t *testing.T) {
		low := Confidence(50, 0, "NEUTRAL", true, 1.0, 14)
		high := Confidence(50, 0, "NEUTRAL", true, 1.0, 60)
		if high <= low {
			t.Errorf("larger sample should increase confidence: low=%f high=%f", low, high)
		}
	})

	t.Run("Agreeing RSI extreme boosts confidence", func(t *testing.T) {
		base := Confidence(50, 0, "NEUTRAL", true, 1.0, 30)
		extreme := Confidence(25, 0.5, "BULLISH", true, 1.0, 30)
		if extreme <= base {
			t.Errorf("extreme agreeing RSI should boost confidence: base=%f extreme=%f", base, extreme)
		}
	})

	t.Run("Disagreeing RSI extreme does not inflate confidence", func(t *testing.T) {
		agreeing := Confidence(25, 0.3, "BULLISH", true, 1.0, 30)
		disagreeing := Confidence(25, 0.3, "BEARISH", true, 1.0, 30)
		if disagreeing >= agreeing {
			t.Errorf("disagreeing RSI should not inflate confidence: agreeing=%f disagreeing=%f", agreeing, disagreeing)
		}
	})

	t.Run("High volume confirmation adds points", func(t *testing.T) {
		normal := Confidence(30, 0.3, "BULLISH", true, 1.0, 30)
		highVol := Confidence(30, 0.3, "BULLISH", true, 2.5, 30)
		if highVol <= normal {
			t.Errorf("high volume should add confidence: normal=%f highVol=%f", normal, highVol)
		}
	})

	t.Run("Score capped at 95", func(t *testing.T) {
		got := Confidence(20, 0.9, "BULLISH", true, 3.0, 100)
		if got > 95 {
			t.Errorf("confidence %f exceeds 95 cap", got)
		}
	})
}
