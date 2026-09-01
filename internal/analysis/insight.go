package analysis

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"

	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// ErrLLMUnavailable is surfaced by any LLMClient when the upstream
// provider refused to serve the request after the client's internal
// retry budget — typically 429 (rate limited) or a 5xx. FallbackLLM
// detects this sentinel to decide whether to try the next provider in
// the chain; permanent errors (bad API key, malformed response) skip
// the fallback and fail fast so we don't burn the entire chain's
// budget on a call we know can't succeed.
var ErrLLMUnavailable = errors.New("llm upstream unavailable")

// MarketDataSource is the narrow interface InsightService needs from the
// time-series store. Defining it locally lets us mock it in tests without
// pulling the full QuestDB repo into a fake.
type MarketDataSource interface {
	GetOHLC(ctx context.Context, symbol, interval string) ([]repository.OHLC, error)
}

// NewsSource fetches headlines for a symbol. Implementations live outside the
// analysis package (e.g. server.googleNewsClient) so we don't bring in
// transport-specific code here.
type NewsSource interface {
	FetchHeadlines(ctx context.Context, symbol string) []Headline
}

// LLMClient generates the prose summary attached to an Insight. The
// implementation may call Gemini, OpenAI, a local model, or just return ""
// (in which case the fallback heuristic is used).
type LLMClient interface {
	Generate(ctx context.Context, prompt string) (string, error)
}

// Insight is the structured output of one analysis pass.
type Insight struct {
	Symbol         string  `json:"symbol"`
	LastPrice      float64 `json:"lastPrice"`
	SMA20          float64 `json:"sma20"`
	SMA20Periods   int     `json:"sma20Periods"`
	SMA50          float64 `json:"sma50"`
	SMA50Periods   int     `json:"sma50Periods"`
	DataPoints     int     `json:"dataPoints"`
	ATR            float64 `json:"atr"`
	PriceRangeLow  float64 `json:"priceRangeLow"`
	PriceRangeHigh float64 `json:"priceRangeHigh"`
	VolumeRatio    float64 `json:"volumeRatio"`
	RSI            float64 `json:"rsi"`
	Sentiment      float64 `json:"sentiment"`
	Confidence     float64 `json:"confidence"`
	Signal         string  `json:"signal"`
	Verdict        string  `json:"verdict,omitempty"`
	Analysis       string  `json:"analysis"`
}

// InsightService composes the data sources and analysis primitives that
// produce a market insight. It is intentionally free of HTTP and caching
// concerns — the handler layer wraps it with those.
type InsightService struct {
	market MarketDataSource
	news   NewsSource
	llm    LLMClient
}

func NewInsightService(market MarketDataSource, news NewsSource, llm LLMClient) *InsightService {
	return &InsightService{market: market, news: news, llm: llm}
}

// LLM exposes the configured LLM client so the briefing service can
// reuse the same model for market summary generation.
func (s *InsightService) LLM() LLMClient { return s.llm }

// ErrInsufficientData is returned when there isn't enough OHLC history to
// produce a meaningful indicator set.
var ErrInsufficientData = errors.New("insufficient data for AI modeling")

// Generate runs the full pipeline for a single symbol.
func (s *InsightService) Generate(ctx context.Context, symbol string) (*Insight, error) {
	data, err := s.market.GetOHLC(ctx, symbol, "1d")
	if err != nil {
		return nil, fmt.Errorf("fetch ohlc: %w", err)
	}
	if len(data) < 14 {
		return nil, ErrInsufficientData
	}

	closes := make([]float64, len(data))
	volumes := make([]int64, len(data))
	highs := make([]float64, len(data))
	lows := make([]float64, len(data))
	for i, d := range data {
		closes[i] = d.Close
		volumes[i] = d.Volume
		highs[i] = d.High
		lows[i] = d.Low
	}

	closePrice := closes[len(closes)-1]
	dataPoints := len(closes)
	sma20 := SMA(closes, 20)
	sma50 := SMA(closes, 50)
	rsi14 := WilderRSI(closes, 14)
	atr14 := ATR(highs, lows, closes, 14)

	// The most recent SAMPLE BY bucket may be a partial day, so use the
	// previous full session's volume when comparing against the 20-day mean.
	lastCompleteVol := volumes[len(volumes)-1]
	if len(volumes) >= 2 {
		lastCompleteVol = volumes[len(volumes)-2]
	}
	avgVol20 := AvgVolume(volumes, 20)
	volumeRatio := 0.0
	if avgVol20 > 0 {
		volumeRatio = float64(lastCompleteVol) / float64(avgVol20)
	}

	headlines := s.news.FetchHeadlines(ctx, symbol)
	sentiment := WeightedSentiment(headlines)

	aboveSMA50 := closePrice > sma50
	aboveSMA20 := closePrice > sma20
	signal := DeriveSignal(rsi14, sentiment, aboveSMA50, aboveSMA20)
	confidence := Confidence(rsi14, sentiment, signal, aboveSMA50, volumeRatio, dataPoints)

	analysisTxt := s.summarize(ctx, symbol, closePrice, sma20, sma50, rsi14, atr14, sentiment, volumeRatio, signal)

	return &Insight{
		Symbol:         symbol,
		LastPrice:      closePrice,
		SMA20:          round2(sma20),
		SMA20Periods:   minInt(dataPoints, 20),
		SMA50:          round2(sma50),
		SMA50Periods:   minInt(dataPoints, 50),
		DataPoints:     dataPoints,
		ATR:            round2(atr14),
		PriceRangeLow:  round2(closePrice - atr14),
		PriceRangeHigh: round2(closePrice + atr14),
		VolumeRatio:    round2(volumeRatio),
		RSI:            round2(rsi14),
		Sentiment:      round2(sentiment),
		Confidence:     confidence,
		Signal:         signal,
		Verdict:        RSIVerdict(rsi14),
		Analysis:       analysisTxt,
	}, nil
}

func (s *InsightService) summarize(ctx context.Context, symbol string, lastPrice, sma20, sma50, rsi, atr, sentiment, volumeRatio float64, signal string) string {
	if s.llm != nil {
		prompt := buildPrompt(symbol, lastPrice, sma20, sma50, rsi, atr, sentiment, volumeRatio, signal)
		if text, err := s.llm.Generate(ctx, prompt); err == nil && text != "" {
			return text
		} else if err != nil {
			slog.Warn("LLM summary failed, using heuristic", "error", err, "symbol", symbol)
		}
	}
	return heuristicSummary(symbol, lastPrice, sma50, rsi, sentiment, volumeRatio, signal)
}

func buildPrompt(symbol string, lastPrice, sma20, sma50, rsi, atr, sentiment, volumeRatio float64, signal string) string {
	volCtx := "average"
	if volumeRatio >= 2.0 {
		volCtx = fmt.Sprintf("%.1fx above average (high conviction)", volumeRatio)
	} else if volumeRatio >= 1.5 {
		volCtx = fmt.Sprintf("%.1fx above average", volumeRatio)
	} else if volumeRatio < 0.5 {
		volCtx = fmt.Sprintf("%.1fx below average (thin trading)", volumeRatio)
	}
	return fmt.Sprintf(
		"You are an elite financial terminal AI for the Ghana Stock Exchange. Write a 2-3 sentence analysis for '%s'. "+
			"Last session VWAP close: ¢%.2f. SMA20: ¢%.2f. SMA50: ¢%.2f. 14-day Wilder RSI: %.1f. "+
			"ATR(14): ¢%.2f (daily volatility range). News sentiment: %.2f (-1 to 1). Volume: %s. Signal: %s. "+
			"This is based on the last available closing price, not a live quote. "+
			"Maintain a professional Bloomberg-terminal tone. No asterisks or markdown.",
		symbol, lastPrice, sma20, sma50, rsi, atr, sentiment, volCtx, signal,
	)
}

func heuristicSummary(symbol string, lastPrice, sma50, rsi, sentiment, volumeRatio float64, signal string) string {
	var rsiText string
	switch {
	case rsi < 30:
		rsiText = "deep in oversold territory, suggesting a potential undervalued scenario"
	case rsi < 45:
		rsiText = "showing slightly chilled momentum but hovering near historical support ranges"
	case rsi < 60:
		rsiText = "exhibiting stable, neutral momentum with balanced buying and selling pressure"
	case rsi < 70:
		rsiText = "pushing into higher momentum zones with growing institutional interest"
	default:
		rsiText = "flashing overbought technical signals, indicating that the recent rally may be stretched"
	}

	actionTxt := "Consider maintaining current allocations"
	if signal == "BULLISH" {
		actionTxt = "A strong momentum case supports accumulation"
	}
	if signal == "BEARISH" {
		actionTxt = "Defensive positioning is advised in the short term"
	}
	if sentiment >= 0.4 {
		actionTxt += ", with news flow providing an additional tailwind"
	} else if sentiment <= -0.4 {
		actionTxt += ", though negative news sentiment warrants caution"
	}

	volTxt := ""
	if volumeRatio >= 2.0 {
		volTxt = fmt.Sprintf(" Session volume ran at %.1fx the 20-day average, providing strong conviction to the move.", volumeRatio)
	} else if volumeRatio < 0.5 {
		volTxt = " Trading volume was notably thin, reducing reliability of the signal."
	}

	trendTxt := ""
	if lastPrice > sma50 {
		trendTxt = fmt.Sprintf(" Price is trading above the 50-day average of ¢%.2f, confirming the broader uptrend.", sma50)
	} else {
		trendTxt = fmt.Sprintf(" Price remains below the 50-day average of ¢%.2f, indicating a prevailing downtrend.", sma50)
	}

	return fmt.Sprintf("AI Consensus: %s closed its last session at a VWAP of ¢%.2f and is %s.%s%s %s as the market digests these indicators.",
		symbol, lastPrice, rsiText, trendTxt, volTxt, actionTxt)
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
