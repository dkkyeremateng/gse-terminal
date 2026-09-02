package repository

import "testing"

// The ±1% fallback used to run per-side, so a synthetic price could land on
// the wrong side of a real one and produce a crossed book — a bid above the
// offer, which is not a slightly wrong number but an impossible one.
func TestSynthesizeQuote(t *testing.T) {
	cases := []struct {
		name                      string
		last, bid, offer          float64
		wantBid, wantOffer        float64
		wantSpread, wantSpreadPct float64
	}{
		{
			// EGL, 2026-09-01. Real bid 6.75, no offer. The old code
			// synthesized 6.53 × 1.01 = 6.60 and reported spread -0.15.
			name: "real bid, missing offer: offer stays absent",
			last: 6.53, bid: 6.75, offer: 0,
			wantBid: 6.75, wantOffer: 0, wantSpread: 0, wantSpreadPct: 0,
		},
		{
			// The mirror case: 4,138 rows in the table.
			name: "real offer, missing bid: bid stays absent",
			last: 1.00, bid: 0, offer: 0.90,
			wantBid: 0, wantOffer: 0.90, wantSpread: 0, wantSpreadPct: 0,
		},
		{
			// The case the heuristic was actually written for — CSV rows
			// carry no depth at all. Symmetric and obviously derived.
			name: "neither side quoted: ±1% band around the last price",
			last: 10.00, bid: 0, offer: 0,
			wantBid: 9.90, wantOffer: 10.10, wantSpread: 0.20, wantSpreadPct: 2,
		},
		{
			name: "both sides quoted: left alone",
			last: 6.92, bid: 6.97, offer: 6.98,
			wantBid: 6.97, wantOffer: 6.98, wantSpread: 0.01, wantSpreadPct: 0.14,
		},
		{
			name: "no price at all: nothing invented",
			last: 0, bid: 0, offer: 0,
			wantBid: 0, wantOffer: 0, wantSpread: 0, wantSpreadPct: 0,
		},
		{
			// The source data itself carries 60 genuinely crossed rows.
			// Those are the exchange's to explain; we must not hide them.
			name: "genuinely crossed source data is reported, not masked",
			last: 5.00, bid: 6.00, offer: 5.50,
			wantBid: 6.00, wantOffer: 5.50, wantSpread: -0.50, wantSpreadPct: -8.7,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			item := MarketSummaryItem{LastPrice: tc.last, BidPrice: tc.bid, OfferPrice: tc.offer}
			synthesizeQuote(&item)
			if item.BidPrice != tc.wantBid || item.OfferPrice != tc.wantOffer {
				t.Errorf("bid/offer = %v/%v, want %v/%v",
					item.BidPrice, item.OfferPrice, tc.wantBid, tc.wantOffer)
			}
			if item.Spread != tc.wantSpread || item.SpreadPct != tc.wantSpreadPct {
				t.Errorf("spread/spreadPct = %v/%v, want %v/%v",
					item.Spread, item.SpreadPct, tc.wantSpread, tc.wantSpreadPct)
			}
		})
	}
}

// No combination of inputs may yield a crossed book out of a one-sided
// quote. A crossed result is only ever allowed to come from source data
// that was already crossed.
func TestSynthesizeQuote_NeverManufacturesACrossedBook(t *testing.T) {
	prices := []float64{0, 0.01, 0.13, 1.00, 6.53, 40.70, 999.99}
	checked := 0
	for _, last := range prices {
		for _, bid := range prices {
			for _, offer := range prices {
				item := MarketSummaryItem{LastPrice: last, BidPrice: bid, OfferPrice: offer}
				sourceCrossed := bid > 0 && offer > 0 && bid > offer
				synthesizeQuote(&item)
				crossed := item.BidPrice > 0 && item.OfferPrice > 0 && item.BidPrice > item.OfferPrice
				if crossed && !sourceCrossed {
					t.Fatalf("manufactured a crossed book from last=%v bid=%v offer=%v -> bid=%v offer=%v",
						last, bid, offer, item.BidPrice, item.OfferPrice)
				}
				if item.Spread < 0 && !sourceCrossed {
					t.Fatalf("negative spread %v from a non-crossed input (last=%v bid=%v offer=%v)",
						item.Spread, last, bid, offer)
				}
				checked++
			}
		}
	}
	t.Logf("%d combinations, no crossed book invented", checked)
}
