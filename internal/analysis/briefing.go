package analysis

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

const MinBriefingSampleSize = 5

const insufficientDataSummary = "Not enough signals to summarise — check back after close."

// BriefingService generates daily market briefings by running
// InsightService.Generate over a list of symbols and producing
// a prose market summary via the LLM.
type BriefingService struct {
	insight *InsightService
	llm     LLMClient
}

func NewBriefingService(insight *InsightService, llm LLMClient) *BriefingService {
	return &BriefingService{insight: insight, llm: llm}
}

// GenerateDailyBriefing runs the insight pipeline over each symbol
// and returns the results. Symbols that fail are logged and skipped.
func (b *BriefingService) GenerateDailyBriefing(ctx context.Context, symbols []string) ([]*Insight, error) {
	var results []*Insight
	for i, sym := range symbols {
		// Pace LLM calls to stay within Gemini's free-tier rate limit
		// (~15 req/min). 5s between calls = 12 req/min max.
		if i > 0 {
			time.Sleep(5 * time.Second)
		}
		insight, err := b.insight.Generate(ctx, sym)
		if err != nil {
			slog.Warn("[briefing] skipping symbol", "symbol", sym, "error", err)
			continue
		}
		results = append(results, insight)
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("no insights generated for any of %d symbols", len(symbols))
	}
	return results, nil
}

// GenerateMarketSummary produces a 3-5 paragraph prose summary of the
// day's trading session by feeding the collected insights into the LLM.
// Falls back to a simple template if the LLM is unavailable.
func (b *BriefingService) GenerateMarketSummary(ctx context.Context, insights []*Insight) (string, error) {
	if len(insights) == 0 {
		return "", fmt.Errorf("no insights to summarize")
	}
	if len(insights) < MinBriefingSampleSize {
		return insufficientDataSummary, nil
	}

	// Build a compact JSON summary for the LLM prompt
	type compactInsight struct {
		Symbol     string  `json:"symbol"`
		Price      float64 `json:"price"`
		RSI        float64 `json:"rsi"`
		Signal     string  `json:"signal"`
		Sentiment  float64 `json:"sentiment"`
		Confidence float64 `json:"confidence"`
	}
	compact := make([]compactInsight, len(insights))
	for i, ins := range insights {
		compact[i] = compactInsight{
			Symbol:     ins.Symbol,
			Price:      ins.LastPrice,
			RSI:        ins.RSI,
			Signal:     ins.Signal,
			Sentiment:  ins.Sentiment,
			Confidence: ins.Confidence,
		}
	}
	data, _ := json.Marshal(compact)

	prompt := fmt.Sprintf(`You are a senior GSE market analyst writing for an institutional terminal.
Summarize today's Ghana Stock Exchange trading session given these stock insights:

%s

Write exactly 3-5 paragraphs covering:
1. Overall market direction and sentiment
2. Notable movers and why they moved
3. Sector themes or patterns

Rules:
- Professional Bloomberg-terminal tone
- No asterisks, markdown, or bullet points
- Reference specific symbols and numbers
- Keep it under 200 words`, string(data))

	if b.llm != nil {
		summary, err := b.llm.Generate(ctx, prompt)
		if err == nil && strings.TrimSpace(summary) != "" {
			return strings.TrimSpace(summary), nil
		}
		slog.Warn("[briefing] LLM summary failed, using fallback", "error", err)
	}

	// Fallback: simple template (case-insensitive signal matching)
	var bullish, bearish int
	for _, ins := range insights {
		sig := strings.ToLower(ins.Signal)
		if strings.Contains(sig, "bullish") || strings.Contains(sig, "bull") {
			bullish++
		} else if strings.Contains(sig, "bearish") || strings.Contains(sig, "bear") {
			bearish++
		}
	}
	return fmt.Sprintf(
		"Today's GSE session saw %d %s analyzed. %d showed bullish signals while %d showed bearish momentum. "+
			"Market sentiment remains mixed as traders digest recent price action across the exchange.",
		len(insights), stockNoun(len(insights)), bullish, bearish,
	), nil
}

func stockNoun(count int) string {
	if count == 1 {
		return "stock"
	}
	return "stocks"
}

func RSIVerdict(rsi float64) string {
	switch {
	case rsi >= 90:
		return "Extreme overbought"
	case rsi > 70:
		return "Overbought"
	case rsi >= 55:
		return "Bullish"
	case rsi >= 45:
		return "Neutral"
	case rsi >= 30:
		return "Bearish"
	default:
		return "Oversold"
	}
}
