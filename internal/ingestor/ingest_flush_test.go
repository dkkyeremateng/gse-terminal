package ingestor

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// fakeSink records what ingest handed it and when it flushed, so the tests
// can tell "counted as inserted" apart from "actually sent".
type fakeSink struct {
	buffered   []repository.Tick
	flushed    []repository.Tick
	flushCalls int
	failAfter  int // return an error from InsertTick once this many rows are in
	flushErr   error
}

func (f *fakeSink) InsertTick(_ context.Context, t repository.Tick) error {
	if f.failAfter > 0 && len(f.buffered) >= f.failAfter {
		return errors.New("sink rejected the row")
	}
	f.buffered = append(f.buffered, t)
	return nil
}

func (f *fakeSink) Flush(context.Context) error {
	f.flushCalls++
	f.flushed = append(f.flushed, f.buffered...)
	f.buffered = nil
	return f.flushErr
}

const hdr = "Daily Date,Share Code,Closing Price - VWAP (GH¢),Total Shares Traded\n"

func ingestString(t *testing.T, sink *fakeSink, body string) (Result, error) {
	t.Helper()
	return NewIngestor(sink).Ingest(context.Background(), strings.NewReader(body))
}

// InsertTick only buffers; rows become durable at Flush. An early return
// used to skip Flush entirely, so Result.Inserted counted rows that were
// then dropped.
func TestIngest_FlushesOnAbort(t *testing.T) {
	sink := &fakeSink{failAfter: 2}
	body := hdr +
		"01/09/2026,MTNGH,2.50,1000\n" +
		"01/09/2026,GCB,5.10,2000\n" +
		"01/09/2026,EGL,1.10,3000\n" // this one is rejected by the sink

	res, err := ingestString(t, sink, body)
	if err == nil {
		t.Fatal("expected an error from the rejected row")
	}
	if sink.flushCalls != 1 {
		t.Errorf("Flush called %d times on the abort path, want 1", sink.flushCalls)
	}
	if len(sink.flushed) != res.Inserted {
		t.Errorf("reported Inserted=%d but only %d rows were flushed; the difference is silently lost data",
			res.Inserted, len(sink.flushed))
	}
}

// One malformed line should not discard the rest of a backfill.
func TestIngest_SkipsShortRowAndKeepsGoing(t *testing.T) {
	sink := &fakeSink{}
	body := hdr +
		"01/09/2026,MTNGH,2.50,1000\n" +
		"01/09/2026,GCB\n" + // short: csv.ErrFieldCount
		"01/09/2026,EGL,1.10,3000\n"

	res, err := ingestString(t, sink, body)
	if err != nil {
		t.Fatalf("a single short row aborted the file: %v", err)
	}
	if res.Inserted != 2 {
		t.Errorf("Inserted = %d, want 2 (the two well-formed rows)", res.Inserted)
	}
	if res.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1", res.Skipped)
	}
	if len(sink.flushed) != 2 {
		t.Errorf("flushed %d rows, want 2", len(sink.flushed))
	}
	// The row after the bad one must survive — that is the whole point.
	var got []string
	for _, tick := range sink.flushed {
		got = append(got, tick.Symbol)
	}
	if strings.Join(got, ",") != "MTNGH,EGL" {
		t.Errorf("flushed symbols = %v, want [MTNGH EGL]", got)
	}
}

// Skipping past bad lines must not become an infinite tolerance for a file
// that is simply the wrong format.
func TestIngest_GivesUpAfterTooManyConsecutiveBadRows(t *testing.T) {
	sink := &fakeSink{}
	var b strings.Builder
	b.WriteString(hdr)
	for i := 0; i < maxConsecutiveReadErrors+10; i++ {
		b.WriteString("01/09/2026,GCB\n") // every row short
	}

	res, err := ingestString(t, sink, b.String())
	if err == nil {
		t.Fatal("expected the run to give up")
	}
	if !strings.Contains(err.Error(), "consecutive unreadable rows") {
		t.Errorf("error = %v, want the give-up message", err)
	}
	if res.Skipped < maxConsecutiveReadErrors {
		t.Errorf("Skipped = %d, want at least %d", res.Skipped, maxConsecutiveReadErrors)
	}
	if sink.flushCalls != 1 {
		t.Errorf("Flush called %d times on the give-up path, want 1", sink.flushCalls)
	}
}

// A flush failure on the happy path has to surface — those rows are not
// durable and the caller must not report them as ingested.
func TestIngest_ReportsFlushFailure(t *testing.T) {
	sink := &fakeSink{flushErr: errors.New("questdb unreachable")}
	_, err := ingestString(t, sink, hdr+"01/09/2026,MTNGH,2.50,1000\n")
	if err == nil {
		t.Fatal("flush failure was swallowed")
	}
	if !strings.Contains(err.Error(), "flushing") {
		t.Errorf("error = %v, want it to name the flush", err)
	}
}

// When both the row and the flush fail, neither cause should be lost.
func TestIngest_ReportsBothCauses(t *testing.T) {
	sink := &fakeSink{failAfter: 1, flushErr: errors.New("questdb unreachable")}
	body := hdr + "01/09/2026,MTNGH,2.50,1000\n" + "01/09/2026,GCB,5.10,2000\n"
	_, err := ingestString(t, sink, body)
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "sink rejected") || !strings.Contains(err.Error(), "flush also failed") {
		t.Errorf("error = %v, want both the insert and flush causes", err)
	}
}
