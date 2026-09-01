package analysis

import (
	"fmt"
	"math"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// AlertType identifies the category of a data quality anomaly.
type AlertType string

const (
	AlertVolumeSpike AlertType = "volume_spike"
	AlertPriceGap    AlertType = "price_gap"
	AlertFlatCandle  AlertType = "flat_candle"
)

// AlertSeverity classifies how urgent the anomaly is.
type AlertSeverity string

const (
	SeverityWarning  AlertSeverity = "warning"
	SeverityCritical AlertSeverity = "critical"
)

// Alert is a single data quality anomaly detected during ingestion.
type Alert struct {
	Symbol      string                 `json:"symbol"`
	TradingDate time.Time              `json:"tradingDate"`
	Type        AlertType              `json:"alertType"`
	Severity    AlertSeverity          `json:"severity"`
	Message     string                 `json:"message"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

// DetectAnomalies checks the latest data point against the trailing
// history for a single symbol and returns any anomalies found.
//
// Checks:
//   - Volume spike: volume > mean + 5σ of trailing 20 days
//   - Price gap: |open - prev_close| > 3 × ATR(14)
//   - Flat candle: close == high == low (likely stale/missing data)
//
// Returns an empty slice if no anomalies are found.
func DetectAnomalies(symbol string, latest repository.OHLC, history []repository.OHLC) []Alert {
	var alerts []Alert

	// 1. Flat candle — close == high == low
	if latest.Close > 0 && latest.Close == latest.High && latest.Close == latest.Low {
		alerts = append(alerts, Alert{
			Symbol:      symbol,
			TradingDate: latest.TradingDate,
			Type:        AlertFlatCandle,
			Severity:    SeverityWarning,
			Message:     fmt.Sprintf("%s: close=high=low (%.2f) — possible stale or missing data", symbol, latest.Close),
			Metadata: map[string]interface{}{
				"close": latest.Close,
			},
		})
	}

	if len(history) < 5 {
		return alerts // not enough history for statistical checks
	}

	// 2. Volume spike — volume > mean + 5σ of trailing 20 days
	volWindow := history
	if len(volWindow) > 20 {
		volWindow = volWindow[len(volWindow)-20:]
	}
	if latest.Volume > 0 {
		var sum, sumSq float64
		var count int
		for _, h := range volWindow {
			if h.Volume > 0 {
				v := float64(h.Volume)
				sum += v
				sumSq += v * v
				count++
			}
		}
		if count >= 5 {
			mean := sum / float64(count)
			variance := (sumSq / float64(count)) - (mean * mean)
			stddev := math.Sqrt(math.Max(variance, 0))
			threshold := mean + 5*stddev
			if float64(latest.Volume) > threshold && threshold > 0 {
				alerts = append(alerts, Alert{
					Symbol:      symbol,
					TradingDate: latest.TradingDate,
					Type:        AlertVolumeSpike,
					Severity:    SeverityCritical,
					Message:     fmt.Sprintf("%s: volume %d exceeds 5σ threshold (%.0f)", symbol, latest.Volume, threshold),
					Metadata: map[string]interface{}{
						"volume":    latest.Volume,
						"mean":      mean,
						"stddev":    stddev,
						"threshold": threshold,
					},
				})
			}
		}
	}

	// 3. Price gap — |open - prev_close| > 3 × ATR(14)
	atrWindow := history
	if len(atrWindow) > 14 {
		atrWindow = atrWindow[len(atrWindow)-14:]
	}
	if len(atrWindow) >= 2 {
		var atrSum float64
		for i := 1; i < len(atrWindow); i++ {
			tr := math.Max(
				atrWindow[i].High-atrWindow[i].Low,
				math.Max(
					math.Abs(atrWindow[i].High-atrWindow[i-1].Close),
					math.Abs(atrWindow[i].Low-atrWindow[i-1].Close),
				),
			)
			atrSum += tr
		}
		atr := atrSum / float64(len(atrWindow)-1)

		prevClose := history[len(history)-1].Close
		gap := math.Abs(latest.Open - prevClose)
		if atr > 0 && gap > 3*atr {
			alerts = append(alerts, Alert{
				Symbol:      symbol,
				TradingDate: latest.TradingDate,
				Type:        AlertPriceGap,
				Severity:    SeverityWarning,
				Message:     fmt.Sprintf("%s: price gap %.2f exceeds 3×ATR (%.2f)", symbol, gap, 3*atr),
				Metadata: map[string]interface{}{
					"gap":       gap,
					"atr":       atr,
					"prevClose": prevClose,
					"open":      latest.Open,
				},
			})
		}
	}

	return alerts
}
