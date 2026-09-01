// Package analysis contains pure financial-analysis primitives (technical
// indicators, sentiment scoring, signal derivation) and the InsightService
// that composes them. Nothing in this package depends on net/http or any
// transport-layer concern, so it can be reused by background jobs, batch
// scoring, and unit tests without spinning up a server.
package analysis

import (
	"math"
)

// SMA returns the simple moving average over the trailing `period` values.
// If `period` exceeds the slice length, all values are averaged.
func SMA(prices []float64, period int) float64 {
	if len(prices) == 0 {
		return 0
	}
	if len(prices) < period {
		period = len(prices)
	}
	sum := 0.0
	for i := len(prices) - period; i < len(prices); i++ {
		sum += prices[i]
	}
	return sum / float64(period)
}

// WilderRSI computes the 14-period (or N-period) RSI using Wilder's smoothed
// (EMA-based) averaging — the canonical formula used by Bloomberg and Reuters.
// Returns 50 when there isn't enough history to compute a meaningful value.
func WilderRSI(prices []float64, period int) float64 {
	if len(prices) < period+1 {
		return 50.0
	}

	avgGain, avgLoss := 0.0, 0.0
	for i := 1; i <= period; i++ {
		diff := prices[i] - prices[i-1]
		if diff > 0 {
			avgGain += diff
		} else {
			avgLoss -= diff
		}
	}
	avgGain /= float64(period)
	avgLoss /= float64(period)

	for i := period + 1; i < len(prices); i++ {
		diff := prices[i] - prices[i-1]
		gain, loss := 0.0, 0.0
		if diff > 0 {
			gain = diff
		} else {
			loss = -diff
		}
		avgGain = (avgGain*float64(period-1) + gain) / float64(period)
		avgLoss = (avgLoss*float64(period-1) + loss) / float64(period)
	}

	if avgLoss == 0 {
		return 100.0
	}
	rs := avgGain / avgLoss
	return 100.0 - (100.0 / (1.0 + rs))
}

// ATR returns the Average True Range over `period` bars, using the standard
// True Range definition (max of high-low, |high-prevClose|, |low-prevClose|).
func ATR(highs, lows, closes []float64, period int) float64 {
	n := len(closes)
	if n < period+1 {
		period = n - 1
	}
	if period <= 0 {
		return 0
	}

	trs := make([]float64, n-1)
	for i := 1; i < n; i++ {
		hl := highs[i] - lows[i]
		hc := math.Abs(highs[i] - closes[i-1])
		lc := math.Abs(lows[i] - closes[i-1])
		trs[i-1] = math.Max(hl, math.Max(hc, lc))
	}

	sum := 0.0
	start := len(trs) - period
	for _, v := range trs[start:] {
		sum += v
	}
	return sum / float64(period)
}

// AvgVolume returns the simple-mean volume over the trailing `period` bars.
func AvgVolume(volumes []int64, period int) int64 {
	if len(volumes) == 0 {
		return 0
	}
	if len(volumes) < period {
		period = len(volumes)
	}
	var sum int64
	for _, v := range volumes[len(volumes)-period:] {
		sum += v
	}
	return sum / int64(period)
}

// DeriveSignal classifies the current setup as BULLISH, BEARISH, or NEUTRAL
// based on the combination of RSI extreme, news sentiment, and trend filters.
//
// BULLISH requires oversold RSI, non-negative sentiment, and the price
// recovering above at least one moving average. BEARISH requires overbought
// RSI in a downtrend OR strong negative sentiment with weakening momentum.
func DeriveSignal(rsi, sentiment float64, aboveSMA50, aboveSMA20 bool) string {
	bullish := rsi < 40 && sentiment >= 0 && (aboveSMA50 || aboveSMA20)
	bearish := (rsi > 70 && !aboveSMA50) || (sentiment < -0.4 && rsi > 55) || (!aboveSMA50 && rsi > 65)
	if bullish {
		return "BULLISH"
	}
	if bearish {
		return "BEARISH"
	}
	return "NEUTRAL"
}

// Confidence returns a 50–95 score expressing how strongly the indicators
// agree with the derived signal. RSI-extremity bonuses are only awarded when
// the extreme matches the signal direction.
func Confidence(rsi, sentiment float64, signal string, aboveSMA50 bool, volumeRatio float64, sampleSize int) float64 {
	score := 50.0

	if sampleSize >= 50 {
		score += 10
	} else if sampleSize >= 30 {
		score += 5
	}

	rsiExtreme := (rsi < 30 && signal == "BULLISH") || (rsi > 70 && signal == "BEARISH")
	rsiMild := (rsi < 40 && signal == "BULLISH") || (rsi > 60 && signal == "BEARISH")
	if rsiExtreme {
		score += 15
	} else if rsiMild {
		score += 8
	}

	sentimentAligned := (sentiment > 0 && signal == "BULLISH") || (sentiment < 0 && signal == "BEARISH")
	absSentiment := math.Abs(sentiment)
	if sentimentAligned && absSentiment >= 0.5 {
		score += 10
	} else if sentimentAligned && absSentiment >= 0.2 {
		score += 5
	}

	if (rsi < 50 && !aboveSMA50) || (rsi > 50 && aboveSMA50) {
		score += 8
	}

	if volumeRatio >= 2.0 {
		score += 7
	} else if volumeRatio >= 1.5 {
		score += 3
	}

	return math.Min(95, score)
}
