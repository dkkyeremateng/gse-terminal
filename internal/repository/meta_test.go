package repository

import "testing"

func TestSectorSeedCoversExpandedBuckets(t *testing.T) {
	tests := map[string]string{
		"SIC":   "Insurance",
		"GLD":   "ETFs",
		"MTNGH": "Telecommunications",
		"GOIL":  "Mining & Oil",
	}

	for symbol, want := range tests {
		if got := GetSector(symbol); got != want {
			t.Fatalf("GetSector(%q) = %q, want %q", symbol, got, want)
		}
	}
}
