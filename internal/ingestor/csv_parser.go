package ingestor

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// symbolRe is the canonical shape of a GSE ticker: an alphabetic-prefixed
// run of upper-case alphanumerics, optionally in space- or hyphen-separated
// groups. The separators are load-bearing — the exchange lists preference
// shares and rights issues as "SCB PREF", "CAL PREF", "GGBL RE", "ALW RE",
// and one historical listing is hyphenated, "SG-SSB". A separator must sit
// between two alphanumeric runs, so leading, trailing and repeated
// separators are rejected.
//
// Verified against all 84 distinct symbols held in production: every one
// matches, so enforcing this at ingest drops no real data.
var symbolRe = regexp.MustCompile(`^[A-Z][A-Z0-9]*(?:[ -][A-Z0-9]+)*$`)

// SymbolMaxLen bounds the whole ticker. The longest real GSE symbol is well
// under this; the cap only stops an unbounded string being stored.
const SymbolMaxLen = 16

// ValidSymbol reports whether sym is a well-formed ticker. This is the
// single definition of the rule — internal/server's handler-side check
// delegates here, so a symbol that cannot be queried can also never be
// stored. Without it the parser accepted any bytes at all, which is how a
// crafted CSV could plant markup that later rendered into an HTML response.
func ValidSymbol(sym string) bool {
	return len(sym) <= SymbolMaxLen && symbolRe.MatchString(sym)
}

type Ingestor struct {
	qdbRepo *repository.QuestDBRepo
}

func NewIngestor(qdbRepo *repository.QuestDBRepo) *Ingestor {
	return &Ingestor{qdbRepo: qdbRepo}
}

// Result summaries an ingestion run so the caller can surface skipped rows
// to the operator instead of silently dropping them.
type Result struct {
	Inserted int
	Skipped  int
}

func (i *Ingestor) Ingest(ctx context.Context, reader io.Reader) (Result, error) {
	return i.ingest(ctx, reader, nil)
}

// IngestTicks behaves like Ingest but also returns every tick it wrote. The
// collector uses the returned rows to build the live WebSocket frame and the
// watchlist digest snapshot without parsing the CSV a second time. Ingest
// stays callback-free so an admin uploading years of history doesn't hold the
// whole file in memory.
func (i *Ingestor) IngestTicks(ctx context.Context, reader io.Reader) (Result, []repository.Tick, error) {
	var ticks []repository.Tick
	res, err := i.ingest(ctx, reader, func(t repository.Tick) {
		ticks = append(ticks, t)
	})
	return res, ticks, err
}

// ingest is the shared implementation. onTick, when non-nil, is called for
// every row that parsed and inserted cleanly.
func (i *Ingestor) ingest(ctx context.Context, reader io.Reader, onTick func(repository.Tick)) (Result, error) {
	csvReader := csv.NewReader(reader)

	headers, err := csvReader.Read()
	if err != nil {
		return Result{}, fmt.Errorf("failed to read headers: %v", err)
	}

	headerMap := make(map[string]int)
	for idx, h := range headers {
		headerMap[normalizeHeader(h)] = idx
	}

	res := Result{}
	row := 0
	for {
		record, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		row++
		if err != nil {
			return res, fmt.Errorf("error reading csv at row %d: %v", row, err)
		}

		tick, err := parseRecord(record, headerMap)
		if err != nil {
			res.Skipped++
			slog.Warn("Skipping malformed CSV row", "row", row, "error", err)
			continue
		}

		if err := i.qdbRepo.InsertTick(ctx, tick); err != nil {
			return res, fmt.Errorf("insert at row %d: %v", row, err)
		}
		res.Inserted++
		if onTick != nil {
			onTick(tick)
		}
	}

	if err := i.qdbRepo.Flush(ctx); err != nil {
		return res, fmt.Errorf("error flushing to QuestDB: %v", err)
	}

	return res, nil
}

func parseRecord(record []string, headerMap map[string]int) (repository.Tick, error) {
	t := repository.Tick{}
	var err error

	// Timestamp records the actual ingestion time
	t.Timestamp = time.Now().UTC()

	if idx, ok := getIdxPrefix(headerMap, "dailydate"); ok {
		t.TradingDate, err = time.Parse("02/01/2006", strings.TrimSpace(record[idx]))
		if err != nil {
			return t, fmt.Errorf("invalid date: %v", err)
		}
	} else {
		return t, fmt.Errorf("no date column found") // Required
	}

	if idx, ok := getIdxPrefix(headerMap, "sharecode", "symbol"); ok {
		// GSE footnote markers ride along inside the symbol field
		// ("**ALW**", "PBC**"). Kept verbatim they become a second,
		// phantom series sitting alongside the real one, splitting a
		// symbol's history in two. Preference lines and rights issues
		// ("SCB PREF", "GGBL RE") are genuinely distinct instruments and
		// are deliberately left alone.
		t.Symbol = strings.TrimSpace(strings.ReplaceAll(record[idx], "*", ""))
		if t.Symbol == "" {
			return t, fmt.Errorf("empty symbol") // Required
		}
		// Constrain the charset. Anything outside it cannot be queried
		// through the API anyway (the handlers apply the same rule), so
		// storing it would only create a row nothing can reach — and the
		// field is rendered into HTML by /v1/symbols/options, which made
		// an unconstrained symbol a stored-XSS vector. A rejected row is
		// counted in Result.Skipped and logged, so a genuinely new ticker
		// shape surfaces rather than vanishing.
		if !ValidSymbol(t.Symbol) {
			return t, fmt.Errorf("symbol %q is not a well-formed ticker", t.Symbol)
		}
	} else {
		return t, fmt.Errorf("no symbol column found") // Required
	}

	if idx, ok := getIdxPrefix(headerMap, "yearhigh"); ok {
		t.YearHigh = parseFloatClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "yearlow"); ok {
		t.YearLow = parseFloatClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "previousclosingprice"); ok {
		t.PrevCloseVWAP = parseFloatClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "openingprice", "openprice"); ok {
		t.OpenPrice = parseFloatClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "lasttransactionprice", "lastprice", "closeprice"); ok {
		t.LastPrice = parseFloatClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "closingpricevwap"); ok {
		t.ClosePriceVWAP = parseFloatClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "pricechange"); ok {
		t.PriceChange = parseFloatClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "closingbidprice"); ok {
		t.BidPrice = parseFloatClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "closingofferprice"); ok {
		t.OfferPrice = parseFloatClean(record[idx])
	}

	if idx, ok := getIdxPrefix(headerMap, "totalsharestraded", "volume"); ok {
		t.TotalVolume = parseIntClean(record[idx])
	}
	if idx, ok := getIdxPrefix(headerMap, "totalvaluetraded"); ok {
		t.TotalValue = parseFloatClean(record[idx])
	}

	return t, nil
}

// getIdxPrefix resolves a column by trying each prefix in the order given,
// which is the order of preference: getIdxPrefix(hm, "lasttransactionprice",
// "lastprice", "closeprice") means "use the last transaction price if the
// file has one, otherwise fall back".
//
// The loops used to be nested the other way round — over the header map on
// the outside, the prefixes on the inside — so the first *header* that
// matched any prefix won, and Go randomises map iteration. With two headers
// sharing a prefix the column chosen varied between runs of the same file:
// measured at 1777/223 and 1761/239 across 2000 calls. Today's GSE export
// has no such collision (all 18 prefixes were checked against its 13
// headers), so this was latent rather than active, but the preference list
// was decorative and a single new column would have made it a live
// silent-corruption bug.
//
// Iterating prefixes on the outside makes precedence real. Within one
// prefix a tie is still possible; the shortest matching header wins, which
// picks the more specific "Last Price" over "Last Price Currency" instead
// of whichever the map happens to yield first.
func getIdxPrefix(headerMap map[string]int, prefixes ...string) (int, bool) {
	for _, p := range prefixes {
		best, bestKey := 0, ""
		for k, idx := range headerMap {
			if !strings.HasPrefix(k, p) {
				continue
			}
			if bestKey == "" || len(k) < len(bestKey) || (len(k) == len(bestKey) && k < bestKey) {
				best, bestKey = idx, k
			}
		}
		if bestKey != "" {
			return best, true
		}
	}
	return 0, false
}

func normalizeHeader(s string) string {
	s = strings.ToLower(s)
	var sb strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

func parseFloatClean(s string) float64 {
	var sb strings.Builder
	for _, r := range s {
		if (r >= '0' && r <= '9') || r == '.' || r == '-' {
			sb.WriteRune(r)
		}
	}
	val := sb.String()
	if val == "" || val == "-" || val == "." {
		return 0
	}
	f, err := strconv.ParseFloat(val, 64)
	if err != nil {
		return 0
	}
	return f
}

func parseIntClean(s string) int64 {
	// Truncate at the decimal separator before stripping punctuation. GSE
	// writes volume as a bare integer in the live export ("1234") but with
	// four decimal places in its historical files ("1234.0000"). Stripping
	// the '.' along with the thousands separators would fold the fractional
	// digits into the integer and multiply the value by 10^4.
	if idx := strings.IndexByte(s, '.'); idx >= 0 {
		s = s[:idx]
	}
	var sb strings.Builder
	for _, r := range s {
		if (r >= '0' && r <= '9') || r == '-' {
			sb.WriteRune(r)
		}
	}
	val := sb.String()
	if val == "" || val == "-" {
		return 0
	}
	i, _ := strconv.ParseInt(val, 10, 64)
	return i
}
