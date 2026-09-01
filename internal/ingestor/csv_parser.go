package ingestor

import (
	"context"
	"encoding/csv"
	"errors"
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

// symbolAliases folds spellings the exchange has used for the same
// instrument onto one canonical ticker.
//
// GSE has published two spellings for each of these, and the split ran
// through the stored history: 'SCB PREF' covered 2010-01-04 to 2025-09-30
// and 'SCBPREF' 2024-02-12 onward, so neither series showed the whole
// instrument. They are the same security — the 2024 row counts are
// complementary (145 + 103 = 248, one full trading year), the price is
// identical either side of the switchover, and on the three dates where
// both appear the values agree or the legacy row carries no published
// price at all.
//
// The unspaced form is canonical because it is what the exchange emits
// today, and therefore what the daily scrape keeps writing.
//
// This is not a one-time correction that the data migration made
// redundant: both spellings appeared on the SAME session (2024-02-12), so
// the export is not internally consistent and could emit the old form
// again. Folding at ingest means it lands on the existing series instead
// of starting a second one.
//
// Only add an entry here when the two spellings are genuinely one
// instrument. 'SG-SSB' keeps its hyphen because nothing else refers to it,
// and preference shares and rights issues ('GGBL RE', 'ALW RE') are
// distinct securities from their ordinary lines, not aliases of them.
var symbolAliases = map[string]string{
	"SCB PREF": "SCBPREF",
	"CAL PREF": "CALPREF",
}

// canonicalSymbol resolves a ticker to the spelling the rest of the system
// stores it under.
func canonicalSymbol(sym string) string {
	if canon, ok := symbolAliases[sym]; ok {
		return canon
	}
	return sym
}

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

// TickSink is the narrow write surface ingest needs. *repository.QuestDBRepo
// satisfies it. Declared as an interface so the ingest loop's error handling
// -- which rows are skipped, when the buffer is flushed -- can be tested
// without a live QuestDB, since flush-on-abort is precisely the behaviour
// that has no observable effect until something goes wrong.
type TickSink interface {
	InsertTick(ctx context.Context, t repository.Tick) error
	Flush(ctx context.Context) error
}

type Ingestor struct {
	qdbRepo TickSink
}

func NewIngestor(qdbRepo TickSink) *Ingestor {
	return &Ingestor{qdbRepo: qdbRepo}
}

// Result summaries an ingestion run so the caller can surface skipped rows
// to the operator instead of silently dropping them.
//
// Inserted counts rows that parsed and were accepted by the ILP sender.
// Rows only become durable at Flush, which is why ingest now flushes on
// every exit path -- previously an abort returned a non-zero Inserted for
// rows still sitting in an unflushed buffer.
type Result struct {
	Inserted int
	Skipped  int
}

// maxConsecutiveReadErrors bounds how many malformed rows in a row we will
// tolerate before giving up on the file. A handful of bad lines is a
// quoting glitch worth skipping past; hundreds back-to-back means we are
// not reading the format we think we are, and continuing would fill the
// log without producing data.
const maxConsecutiveReadErrors = 50

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
	consecutiveReadErrs := 0

	// flush sends whatever the ILP sender is holding. It has to run on
	// every exit path, not just the happy one: InsertTick only buffers, so
	// an early return left an unknown tail of already-counted rows
	// unflushed and reported them as Inserted anyway.
	flush := func(cause error) (Result, error) {
		ferr := i.qdbRepo.Flush(ctx)
		switch {
		case cause != nil && ferr != nil:
			return res, fmt.Errorf("%w (flush also failed: %v)", cause, ferr)
		case cause != nil:
			return res, cause
		case ferr != nil:
			return res, fmt.Errorf("error flushing to QuestDB: %v", ferr)
		}
		return res, nil
	}

	for {
		record, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		row++
		if err != nil {
			// A malformed line is a property of that line, not of the
			// file. Skipping it matches how a row that fails parseRecord
			// is handled, and keeps one bad line in a 10,000-row backfill
			// from discarding the other 9,999.
			//
			// encoding/csv returns the record alongside ErrFieldCount and
			// resumes from the next line, so continuing is safe; parseRecord
			// bounds-checks every column access for the short-row case.
			// Anything that is not a parse error (an I/O failure on the
			// underlying reader) is not per-line and does abort.
			var parseErr *csv.ParseError
			if !errors.As(err, &parseErr) {
				return flush(fmt.Errorf("error reading csv at row %d: %v", row, err))
			}
			consecutiveReadErrs++
			res.Skipped++
			slog.Warn("Skipping unreadable CSV row", "row", row, "error", err)
			if consecutiveReadErrs >= maxConsecutiveReadErrors {
				return flush(fmt.Errorf("giving up at row %d after %d consecutive unreadable rows; the file is probably not the expected format",
					row, consecutiveReadErrs))
			}
			continue
		}
		consecutiveReadErrs = 0

		tick, err := parseRecord(record, headerMap)
		if err != nil {
			res.Skipped++
			slog.Warn("Skipping malformed CSV row", "row", row, "error", err)
			continue
		}

		if err := i.qdbRepo.InsertTick(ctx, tick); err != nil {
			return flush(fmt.Errorf("insert at row %d: %v", row, err))
		}
		res.Inserted++
		if onTick != nil {
			onTick(tick)
		}
	}

	return flush(nil)
}

// field reads a column by index, returning "" when the row is shorter than
// the header. Rows with a field-count mismatch are now skipped rather than
// aborting the file, so every access here has to tolerate a short record --
// an unchecked record[idx] would panic on the first one.
func field(record []string, idx int) string {
	if idx < 0 || idx >= len(record) {
		return ""
	}
	return record[idx]
}

func parseRecord(record []string, headerMap map[string]int) (repository.Tick, error) {
	t := repository.Tick{}
	var err error

	// Timestamp records the actual ingestion time
	t.Timestamp = time.Now().UTC()

	if idx, ok := getIdxPrefix(headerMap, "dailydate"); ok {
		t.TradingDate, err = time.Parse("02/01/2006", strings.TrimSpace(field(record, idx)))
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
		t.Symbol = strings.TrimSpace(strings.ReplaceAll(field(record, idx), "*", ""))
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
		// Fold known alternate spellings onto one series. Done after
		// validation so an alias entry cannot smuggle past the charset
		// check, and after asterisk-stripping so a footnote-marked
		// "SCB PREF**" still resolves.
		t.Symbol = canonicalSymbol(t.Symbol)
	} else {
		return t, fmt.Errorf("no symbol column found") // Required
	}

	if idx, ok := getIdxPrefix(headerMap, "yearhigh"); ok {
		t.YearHigh = parseFloatClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "yearlow"); ok {
		t.YearLow = parseFloatClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "previousclosingprice"); ok {
		t.PrevCloseVWAP = parseFloatClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "openingprice", "openprice"); ok {
		t.OpenPrice = parseFloatClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "lasttransactionprice", "lastprice", "closeprice"); ok {
		t.LastPrice = parseFloatClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "closingpricevwap"); ok {
		t.ClosePriceVWAP = parseFloatClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "pricechange"); ok {
		t.PriceChange = parseFloatClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "closingbidprice"); ok {
		t.BidPrice = parseFloatClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "closingofferprice"); ok {
		t.OfferPrice = parseFloatClean(field(record, idx))
	}

	if idx, ok := getIdxPrefix(headerMap, "totalsharestraded", "volume"); ok {
		t.TotalVolume = parseIntClean(field(record, idx))
	}
	if idx, ok := getIdxPrefix(headerMap, "totalvaluetraded"); ok {
		t.TotalValue = parseFloatClean(field(record, idx))
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
