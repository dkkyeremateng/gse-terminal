// Package analysis — backtester.
//
// Walks historical OHLC data for a symbol through the same technical
// signal pipeline used by InsightService.Generate, recording what each
// signal would have predicted and what actually happened over forward
// windows of 1, 5, and 20 trading days. Aggregates the results into
// win rate, average return, Sharpe ratio, max drawdown, and a per-day
// signal time series.
//
// Key difference from live insight: the backtest is **deterministic**.
// It uses the technical indicators only (SMA20, SMA50, RSI14, ATR14,
// volume ratio) and sets sentiment to 0.0 (no news lookback) so the
// results are reproducible and free of non-deterministic LLM/API calls.
// The trade-off is that sentiment-driven signal flips are invisible to
// the backtest — acknowledged in the API response.

package analysis

import (
	"context"
	"fmt"
	"math"
	"time"
)

// BacktestOpts controls the backtest window and forward-return horizons.
type BacktestOpts struct {
	// MinLookback is the minimum number of bars before the first signal.
	// Must be >= 50 (for SMA50). Defaults to 50 if zero.
	MinLookback int
	// ForwardDays is the set of forward-return horizons measured after
	// each signal. Defaults to [1, 5, 20].
	ForwardDays []int
}

func (o *BacktestOpts) lookback() int {
	if o != nil && o.MinLookback >= 50 {
		return o.MinLookback
	}
	return 50
}

func (o *BacktestOpts) horizons() []int {
	if o != nil && len(o.ForwardDays) > 0 {
		return o.ForwardDays
	}
	return []int{1, 5, 20}
}

// BacktestResult is the JSON payload returned by the backtest endpoint.
type BacktestResult struct {
	Symbol       string           `json:"symbol"`
	StartDate    string           `json:"startDate"`
	EndDate      string           `json:"endDate"`
	TotalSignals int              `json:"totalSignals"`
	Bullish      int              `json:"bullish"`
	Bearish      int              `json:"bearish"`
	Neutral      int              `json:"neutral"`
	WinRate1D    float64          `json:"winRate1d"`
	WinRate5D    float64          `json:"winRate5d"`
	WinRate20D   float64          `json:"winRate20d"`
	AvgReturn5D  float64          `json:"avgReturn5d"`
	SharpeRatio  float64          `json:"sharpeRatio"`
	MaxDrawdown  float64          `json:"maxDrawdown"`
	// Note is a transparency disclaimer surfaced in the API response so
	// the consumer knows sentiment was zeroed.
	Note    string           `json:"note"`
	Signals []SignalSnapshot `json:"signals"`
}

// SignalSnapshot is one row in the backtest time series.
type SignalSnapshot struct {
	Date           string  `json:"date"`
	Close          float64 `json:"close"`
	Signal         string  `json:"signal"`
	Confidence     float64 `json:"confidence"`
	RSI            float64 `json:"rsi"`
	SMA20          float64 `json:"sma20"`
	SMA50          float64 `json:"sma50"`
	ForwardReturn  map[string]float64 `json:"forwardReturn"` // keyed by "1d", "5d", "20d"
}

// BacktestService runs deterministic technical backtests.
type BacktestService struct {
	market MarketDataSource
}

func NewBacktestService(market MarketDataSource) *BacktestService {
	return &BacktestService{market: market}
}

// sanitizeFloat replaces NaN and ±Inf with 0. Go's json.Encoder can't
// serialise those IEEE specials and would write a partial response body,
// which the browser sees as "Unexpected end of JSON input".
func sanitizeFloat(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

// Run executes the backtest for a single symbol. It fetches the full
// daily OHLC series, slides a growing window from bar [lookback..N],
// computes signals at each step, and records actual forward returns.
func (b *BacktestService) Run(ctx context.Context, symbol string, opts *BacktestOpts) (*BacktestResult, error) {
	data, err := b.market.GetOHLC(ctx, symbol, "1d")
	if err != nil {
		return nil, fmt.Errorf("fetch ohlc: %w", err)
	}
	lookback := opts.lookback()
	horizons := opts.horizons()
	maxHorizon := 0
	for _, h := range horizons {
		if h > maxHorizon {
			maxHorizon = h
		}
	}

	// Need enough data for at least the lookback window + the longest
	// forward horizon + 1 tradable bar.
	minBars := lookback + maxHorizon + 1
	if len(data) < minBars {
		return nil, fmt.Errorf("insufficient data: need %d bars, have %d", minBars, len(data))
	}

	// Build full-length slices once; the loop indexes into them.
	closes := make([]float64, len(data))
	highs := make([]float64, len(data))
	lows := make([]float64, len(data))
	volumes := make([]int64, len(data))
	dates := make([]time.Time, len(data))
	for i, d := range data {
		closes[i] = d.Close
		highs[i] = d.High
		lows[i] = d.Low
		volumes[i] = d.Volume
		dates[i] = d.TradingDate
	}

	// The last index where we can still measure the longest forward return.
	lastIdx := len(data) - maxHorizon - 1

	var signals []SignalSnapshot
	var bullish, bearish, neutral int
	var wins1, wins5, wins20, counted1, counted5, counted20 int
	var dailyReturns []float64 // for Sharpe
	var fwd5Returns []float64  // for avg return

	// Simulated equity curve for max-drawdown. Starts at 1.0.
	equity := 1.0
	peak := 1.0
	maxDD := 0.0

	for i := lookback; i <= lastIdx; i++ {
		// --- Compute signal at bar i using data [0..i] ---
		window := closes[:i+1]
		sma20 := SMA(window, 20)
		sma50 := SMA(window, 50)
		rsi14 := WilderRSI(window, 14)
		atr14 := ATR(highs[:i+1], lows[:i+1], window, 14)
		_ = atr14 // used only for context; signal logic doesn't consume ATR directly

		// Volume ratio vs 20-day average (same as insight.go:108-115).
		volWindow := volumes[:i+1]
		avgVol := AvgVolume(volWindow, 20)
		var volumeRatio float64
		if avgVol > 0 {
			volumeRatio = float64(volWindow[len(volWindow)-1]) / float64(avgVol)
		}

		aboveSMA50 := closes[i] > sma50
		aboveSMA20 := closes[i] > sma20
		signal := DeriveSignal(rsi14, 0.0, aboveSMA50, aboveSMA20) // sentiment=0
		confidence := Confidence(rsi14, 0.0, signal, aboveSMA50, volumeRatio, i+1)

		switch signal {
		case "BULLISH":
			bullish++
		case "BEARISH":
			bearish++
		default:
			neutral++
		}

		// --- Forward returns ---
		fwdMap := make(map[string]float64, len(horizons))
		for _, h := range horizons {
			if i+h < len(data) && closes[i] > 0 {
				fwd := (closes[i+h] - closes[i]) / closes[i] * 100
				key := fmt.Sprintf("%dd", h)
				fwdMap[key] = sanitizeFloat(math.Round(fwd*100) / 100)

				// Win-rate tracking (bullish signal → price went up).
				if signal == "BULLISH" {
					switch h {
					case 1:
						counted1++
						if fwd > 0 {
							wins1++
						}
					case 5:
						counted5++
						if fwd > 0 {
							wins5++
						}
						fwd5Returns = append(fwd5Returns, fwd)
					case 20:
						counted20++
						if fwd > 0 {
							wins20++
						}
					}
				}
			}
		}

		// Daily return for Sharpe (signal-aware: +1x for bullish, -1x for
		// bearish, 0 for neutral — a simple long/short/flat strategy).
		if i > lookback && closes[i-1] > 0 {
			dayReturn := (closes[i] - closes[i-1]) / closes[i-1]
			switch signal {
			case "BULLISH":
				dailyReturns = append(dailyReturns, dayReturn)
				equity *= (1 + dayReturn)
			case "BEARISH":
				dailyReturns = append(dailyReturns, -dayReturn) // short
				equity *= (1 - dayReturn)
			default:
				dailyReturns = append(dailyReturns, 0) // flat
			}
			if equity > peak {
				peak = equity
			}
			dd := (peak - equity) / peak * 100
			if dd > maxDD {
				maxDD = dd
			}
		}

		signals = append(signals, SignalSnapshot{
			Date:          dates[i].Format("2006-01-02"),
			Close:         sanitizeFloat(math.Round(closes[i]*100) / 100),
			Signal:        signal,
			Confidence:    sanitizeFloat(math.Round(confidence*10) / 10),
			RSI:           sanitizeFloat(math.Round(rsi14*10) / 10),
			SMA20:         sanitizeFloat(math.Round(sma20*100) / 100),
			SMA50:         sanitizeFloat(math.Round(sma50*100) / 100),
			ForwardReturn: fwdMap,
		})
	}

	// --- Aggregate stats ---
	winRate := func(wins, total int) float64 {
		if total == 0 {
			return 0
		}
		return math.Round(float64(wins)/float64(total)*10000) / 100
	}

	avgFwd5 := 0.0
	if len(fwd5Returns) > 0 {
		sum := 0.0
		for _, r := range fwd5Returns {
			sum += r
		}
		avgFwd5 = math.Round(sum/float64(len(fwd5Returns))*100) / 100
	}

	sharpe := 0.0
	if len(dailyReturns) > 1 {
		mean := 0.0
		for _, r := range dailyReturns {
			mean += r
		}
		mean /= float64(len(dailyReturns))
		variance := 0.0
		for _, r := range dailyReturns {
			variance += (r - mean) * (r - mean)
		}
		variance /= float64(len(dailyReturns) - 1)
		std := math.Sqrt(variance)
		if std > 0 {
			sharpe = math.Round(mean/std*math.Sqrt(252)*100) / 100
		}
	}

	startDate := ""
	endDate := ""
	if len(signals) > 0 {
		startDate = signals[0].Date
		endDate = signals[len(signals)-1].Date
	}

	return &BacktestResult{
		Symbol:       symbol,
		StartDate:    startDate,
		EndDate:      endDate,
		TotalSignals: len(signals),
		Bullish:      bullish,
		Bearish:      bearish,
		Neutral:      neutral,
		WinRate1D:    sanitizeFloat(winRate(wins1, counted1)),
		WinRate5D:    sanitizeFloat(winRate(wins5, counted5)),
		WinRate20D:   sanitizeFloat(winRate(wins20, counted20)),
		AvgReturn5D:  sanitizeFloat(avgFwd5),
		SharpeRatio:  sanitizeFloat(sharpe),
		MaxDrawdown:  sanitizeFloat(math.Round(maxDD*100) / 100),
		Note:         "Backtest uses technical indicators only (SMA20, SMA50, RSI14, volume ratio). News sentiment is zeroed, so sentiment-driven signal flips are not captured. Past performance does not predict future results.",
		Signals:      signals,
	}, nil
}
