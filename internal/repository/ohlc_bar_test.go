package repository

import (
	"testing"
	"time"
)

func f(v float64) *float64 { return &v }

// The exchange publishes no intraday extremes, so high and low used to come
// from close_price_vwap alone. On a day the open differed from the VWAP the
// bar was self-contradictory — on live data that was 721 of MTNGH's 1,959
// sessions. These are the real shapes that produced it.
func TestOHLCRowResolve(t *testing.T) {
	day := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name               string
		row                ohlcRow
		wantOpen, wantHigh float64
		wantLow, wantClose float64
	}{
		{
			// 2026-09-01 MTNGH: open 6.97, VWAP close 6.92. Previously
			// high=6.92, i.e. below the open.
			name: "down day: open becomes the high",
			row: ohlcRow{TradingDate: day, Open: f(6.97),
				HighOpen: f(6.97), HighClose: 6.92, HighLast: f(6.92),
				LowOpen: f(6.97), LowClose: 6.92, LowLast: f(6.92),
				Close: 6.92, Volume: 3144924},
			wantOpen: 6.97, wantHigh: 6.97, wantLow: 6.92, wantClose: 6.92,
		},
		{
			// 2026-08-31 MTNGH: open 6.91, close 6.97. Previously low=6.97,
			// i.e. above the open.
			name: "up day: open becomes the low",
			row: ohlcRow{TradingDate: day, Open: f(6.91),
				HighOpen: f(6.91), HighClose: 6.97, HighLast: f(6.97),
				LowOpen: f(6.91), LowClose: 6.97, LowLast: f(6.97),
				Close: 6.97, Volume: 252914},
			wantOpen: 6.91, wantHigh: 6.97, wantLow: 6.91, wantClose: 6.97,
		},
		{
			// last_price is 0 on a day with no trade; nullif makes it NULL
			// so it must not drag the low to zero — the bug PR #5 fixed for
			// close_price_vwap, which this must not reintroduce.
			name: "null components are ignored, not treated as zero",
			row: ohlcRow{TradingDate: day, Open: f(0.74),
				HighOpen: f(0.74), HighClose: 0.74, HighLast: nil,
				LowOpen: f(0.74), LowClose: 0.74, LowLast: nil,
				Close: 0.74, Volume: 400},
			wantOpen: 0.74, wantHigh: 0.74, wantLow: 0.74, wantClose: 0.74,
		},
		{
			// Four rows in the table carry a real close with no opening
			// price. Left at zero the open would sit below its own bar.
			name: "absent open falls back to the close",
			row: ohlcRow{TradingDate: day, Open: nil,
				HighOpen: nil, HighClose: 0.42, HighLast: f(0.42),
				LowOpen: nil, LowClose: 0.42, LowLast: f(0.42),
				Close: 0.42, Volume: 0},
			wantOpen: 0.42, wantHigh: 0.42, wantLow: 0.42, wantClose: 0.42,
		},
		{
			// A multi-day bucket (1w / 1M) spans several sessions, so the
			// extremes come from different columns on different days.
			name: "weekly bucket spans all three price columns",
			row: ohlcRow{TradingDate: day, Open: f(6.90),
				HighOpen: f(7.00), HighClose: 6.97, HighLast: f(7.05),
				LowOpen: f(6.85), LowClose: 6.88, LowLast: f(6.80),
				Close: 6.92, Volume: 1_000_000},
			wantOpen: 6.90, wantHigh: 7.05, wantLow: 6.80, wantClose: 6.92,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.row.resolve()
			if got.Open != tc.wantOpen || got.High != tc.wantHigh ||
				got.Low != tc.wantLow || got.Close != tc.wantClose {
				t.Errorf("O=%v H=%v L=%v C=%v, want O=%v H=%v L=%v C=%v",
					got.Open, got.High, got.Low, got.Close,
					tc.wantOpen, tc.wantHigh, tc.wantLow, tc.wantClose)
			}
			// The invariant the whole change exists to restore.
			if got.Open < got.Low || got.Open > got.High {
				t.Errorf("open %v outside [%v, %v]", got.Open, got.Low, got.High)
			}
			if got.Close < got.Low || got.Close > got.High {
				t.Errorf("close %v outside [%v, %v]", got.Close, got.Low, got.High)
			}
			if got.High < got.Low {
				t.Errorf("high %v below low %v", got.High, got.Low)
			}
		})
	}
}

// Whatever the inputs, a resolved bar must be internally consistent. This is
// the property the previous projection could not hold.
func TestOHLCRowResolve_AlwaysConsistent(t *testing.T) {
	prices := []*float64{nil, f(0), f(0.5), f(1.0), f(2.0), f(7.5)}
	day := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	checked := 0
	for _, open := range prices {
		for _, hiO := range prices {
			for _, loO := range prices {
				for _, hiL := range prices {
					for _, loL := range prices {
						row := ohlcRow{
							TradingDate: day, Open: open,
							HighOpen: hiO, HighClose: 2.0, HighLast: hiL,
							LowOpen: loO, LowClose: 2.0, LowLast: loL,
							Close: 2.0,
						}
						got := row.resolve()
						if got.High < got.Low {
							t.Fatalf("high %v below low %v (row %+v)", got.High, got.Low, row)
						}
						if got.Close < got.Low || got.Close > got.High {
							t.Fatalf("close %v outside [%v,%v] (row %+v)", got.Close, got.Low, got.High, row)
						}
						if got.Open < got.Low || got.Open > got.High {
							t.Fatalf("open %v outside [%v,%v] (row %+v)", got.Open, got.Low, got.High, row)
						}
						checked++
					}
				}
			}
		}
	}
	t.Logf("%d combinations, all internally consistent", checked)
}
