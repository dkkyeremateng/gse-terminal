package repository

import "sync"

// SectorSeed is the built-in industry classification for Ghana Stock Exchange
// symbols. It acts as the seed/fallback when no DB override is configured for
// a symbol. Live overrides loaded from the `sector_overrides` table take
// precedence — see SetSectorOverrides / GetSector.
var SectorSeed = map[string]string{
	// Banking
	"ACCESS":  "Banking",
	"ADB":     "Banking", // Agricultural Development Bank
	"CAL":     "Banking",
	"ETI":     "Banking", // Ecobank Transnational
	"ETIT":    "Banking",
	"GCB":     "Banking",
	"RBGH":    "Banking",
	"SCB":     "Banking",
	"SCBPREF": "Banking", // Standard Chartered preferred shares
	"SOGEGH":  "Banking",
	"TBL":     "Banking",
	"EGH":     "Banking",

	// Insurance / Finance
	"EGL": "Insurance",
	"SIC": "Insurance",

	// Telecommunications
	"MTNGH": "Telecommunications",

	// Mining & Oil
	"AGA":   "Mining & Oil", // AngloGold Ashanti
	"GOIL":  "Mining & Oil",
	"TOTAL": "Mining & Oil",
	"TLW":   "Mining & Oil",
	"ZEN":   "Mining & Oil", // ZEN Petroleum

	// ETFs
	"GLD": "ETFs",

	// Consumer Goods & Food
	"FML":    "Consumer Goods",
	"GGBL":   "Consumer Goods",
	"UNIL":   "Consumer Goods",
	"FANMIL": "Consumer Goods",
	"PZC":    "Consumer Goods",
	"BOPP":   "Consumer Goods",

	// Manufacturing
	"MAC":   "Manufacturing",
	"HORDS": "Manufacturing",
	"SAMBA": "Manufacturing",
	"CPC":   "Manufacturing",
	"CLYD":  "Manufacturing",
}

var (
	sectorOverridesMu sync.RWMutex
	sectorOverrides   = map[string]string{}
)

// SetSectorOverrides replaces the in-memory override map atomically.
// Pass the full snapshot from the DB on startup or after admin mutations.
func SetSectorOverrides(m map[string]string) {
	sectorOverridesMu.Lock()
	defer sectorOverridesMu.Unlock()
	cp := make(map[string]string, len(m))
	for k, v := range m {
		cp[k] = v
	}
	sectorOverrides = cp
}

// SetSectorOverride upserts a single override (used by admin endpoints
// after writing to the DB so the change is visible immediately without
// a full reload).
func SetSectorOverride(symbol, sector string) {
	sectorOverridesMu.Lock()
	defer sectorOverridesMu.Unlock()
	sectorOverrides[symbol] = sector
}

// DeleteSectorOverride removes an override, falling the symbol back to the
// built-in seed map.
func DeleteSectorOverride(symbol string) {
	sectorOverridesMu.Lock()
	defer sectorOverridesMu.Unlock()
	delete(sectorOverrides, symbol)
}

// GetSector returns the sector name for a given symbol. Override layer is
// checked first, then the built-in seed. Returns "Other" if neither has it.
func GetSector(symbol string) string {
	sectorOverridesMu.RLock()
	if v, ok := sectorOverrides[symbol]; ok {
		sectorOverridesMu.RUnlock()
		return v
	}
	sectorOverridesMu.RUnlock()
	if v, ok := SectorSeed[symbol]; ok {
		return v
	}
	return "Other"
}

// AllSectorMappings returns the merged view of seed + overrides as a single
// flat map (overrides win). Useful for the admin sectors editor.
func AllSectorMappings() map[string]string {
	sectorOverridesMu.RLock()
	defer sectorOverridesMu.RUnlock()
	out := make(map[string]string, len(SectorSeed)+len(sectorOverrides))
	for k, v := range SectorSeed {
		out[k] = v
	}
	for k, v := range sectorOverrides {
		out[k] = v
	}
	return out
}
