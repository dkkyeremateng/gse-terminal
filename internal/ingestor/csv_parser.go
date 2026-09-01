package ingestor

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/repository"
)

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
		t.Symbol = strings.TrimSpace(record[idx])
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

func getIdxPrefix(headerMap map[string]int, prefixes ...string) (int, bool) {
	for k, idx := range headerMap {
		for _, p := range prefixes {
			if strings.HasPrefix(k, p) {
				return idx, true
			}
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
