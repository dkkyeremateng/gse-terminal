package analysis

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// stubLLM records the prompt it was handed and replays a canned answer.
type stubLLM struct {
	prompt string
	reply  string
	err    error
}

func (s *stubLLM) Generate(_ context.Context, prompt string) (string, error) {
	s.prompt = prompt
	return s.reply, s.err
}

var asOf = time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC)

// qc is the default context for tests that don't care about sectors.
var qc = QueryContext{DataAsOf: asOf}

// The prompt has to pin the dialect, the reachable schema, and the data's
// own end date — the three things whose absence produced today(),
// sector_overrides joins, and now()-relative filters that match nothing.
func TestGenerateSQLPromptPinsDialectAndDataWindow(t *testing.T) {
	llm := &stubLLM{reply: "SELECT symbol FROM equities WHERE trading_date = '2026-08-21' LIMIT 5"}
	svc := NewQueryService(llm)

	if _, err := svc.GenerateSQL(context.Background(), "top movers", qc); err != nil {
		t.Fatalf("GenerateSQL: %v", err)
	}

	for _, want := range []string{
		"QuestDB",
		"2026-08-21",             // the real latest session, injected
		"NEVER use today()",      // the function that broke execution
		"That is the only table", // no sector_overrides to join against
		unsupportedMarker,
	} {
		if !strings.Contains(llm.prompt, want) {
			t.Errorf("prompt missing %q", want)
		}
	}
	if strings.Contains(llm.prompt, "sector_overrides") {
		t.Error("prompt still advertises sector_overrides, which lives in Postgres, not QuestDB")
	}
	if !strings.Contains(llm.prompt, "User question: top movers") {
		t.Error("question not appended to the prompt")
	}
}

// A zero date must not reach the prompt as a zero-value literal.
func TestGenerateSQLZeroDateFallsBackToToday(t *testing.T) {
	llm := &stubLLM{reply: "SELECT symbol FROM equities WHERE symbol = 'MTNGH' LIMIT 5"}
	svc := NewQueryService(llm)

	if _, err := svc.GenerateSQL(context.Background(), "q", QueryContext{}); err != nil {
		t.Fatalf("GenerateSQL: %v", err)
	}
	if strings.Contains(llm.prompt, "0001-01-01") {
		t.Error("zero time leaked into the prompt")
	}
	if want := time.Now().UTC().Format("2006-01-02"); !strings.Contains(llm.prompt, want) {
		t.Errorf("prompt should fall back to %s", want)
	}
}

func TestGenerateSQLUnsupportedQuestion(t *testing.T) {
	for _, reply := range []string{"UNSUPPORTED", " unsupported ", "```\nUNSUPPORTED\n```"} {
		svc := NewQueryService(&stubLLM{reply: reply})
		_, err := svc.GenerateSQL(context.Background(), "which banks are in the financial sector?", qc)
		if !errors.Is(err, ErrQuestionUnsupported) {
			t.Errorf("reply %q: err = %v, want ErrQuestionUnsupported", reply, err)
		}
	}
}

func TestGenerateSQLRejectsUnsafeOutput(t *testing.T) {
	cases := []struct {
		name  string
		reply string
	}{
		{"mutation", "DELETE FROM equities WHERE symbol = 'MTNGH'"},
		{"chained statement", "SELECT symbol FROM equities WHERE 1=1; DROP TABLE equities"},
		{"no where clause", "SELECT symbol FROM equities LIMIT 5"},
		{"prose instead of sql", "I cannot answer that question."},
		{"cte without select", "WITH x AS (nonsense) x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := NewQueryService(&stubLLM{reply: tc.reply})
			if _, err := svc.GenerateSQL(context.Background(), "q", qc); err == nil {
				t.Errorf("accepted unsafe output: %q", tc.reply)
			}
		})
	}
}

// QuestDB supports CTEs and the prompt recommends them for per-symbol
// comparisons, so the validator must not reject a leading WITH.
func TestValidateSQLAcceptsCTE(t *testing.T) {
	cte := "WITH avg30 AS (\n  SELECT symbol, avg(close_price_vwap) AS a FROM equities WHERE trading_date > '2026-07-21' GROUP BY symbol\n)\nSELECT symbol FROM avg30 WHERE a > 1 LIMIT 50"
	svc := NewQueryService(&stubLLM{reply: cte})
	got, err := svc.GenerateSQL(context.Background(), "q", qc)
	if err != nil {
		t.Fatalf("CTE rejected: %v", err)
	}
	if !strings.HasPrefix(got, "WITH") {
		t.Errorf("sql = %q", got)
	}
}

// Fenced SQL is the single most common shape an LLM returns.
func TestGenerateSQLStripsMarkdownFence(t *testing.T) {
	svc := NewQueryService(&stubLLM{
		reply: "```sql\nSELECT symbol FROM equities WHERE trading_date = '2026-08-21' LIMIT 5;\n```",
	})
	sql, err := svc.GenerateSQL(context.Background(), "q", qc)
	if err != nil {
		t.Fatalf("GenerateSQL: %v", err)
	}
	if strings.Contains(sql, "`") || strings.Contains(sql, ";") {
		t.Errorf("fence or semicolon survived: %q", sql)
	}
}

func TestGenerateSQLPropagatesLLMError(t *testing.T) {
	svc := NewQueryService(&stubLLM{err: errors.New("boom")})
	if _, err := svc.GenerateSQL(context.Background(), "q", qc); err == nil {
		t.Fatal("want error")
	}
}

func TestRepairSQLFeedsDatabaseErrorBack(t *testing.T) {
	llm := &stubLLM{reply: "SELECT symbol, avg(close_price_vwap) OVER (PARTITION BY symbol) FROM equities WHERE trading_date = '2026-08-21' LIMIT 50"}
	svc := NewQueryService(llm)

	bad := "SELECT symbol FROM equities e1 WHERE close_price_vwap > (SELECT min(close_price_vwap) FROM equities e2 WHERE e2.symbol = e1.symbol)"
	sql, err := svc.RepairSQL(context.Background(), "cheapest banks", bad, "Invalid table name or alias", qc)
	if err != nil {
		t.Fatalf("RepairSQL: %v", err)
	}
	if !strings.Contains(sql, "OVER (PARTITION BY") {
		t.Errorf("repaired sql = %q", sql)
	}
	// The retry has to carry both the rejected statement and the engine's
	// complaint, or the model is just guessing again.
	for _, want := range []string{bad, "Invalid table name or alias", "cheapest banks", "QuestDB"} {
		if !strings.Contains(llm.prompt, want) {
			t.Errorf("repair prompt missing %q", want)
		}
	}
}

func TestRepairSQLUnsupportedAndUnsafe(t *testing.T) {
	svc := NewQueryService(&stubLLM{reply: unsupportedMarker})
	if _, err := svc.RepairSQL(context.Background(), "q", "SELECT 1", "boom", qc); !errors.Is(err, ErrQuestionUnsupported) {
		t.Errorf("err = %v, want ErrQuestionUnsupported", err)
	}

	svc = NewQueryService(&stubLLM{reply: "DROP TABLE equities"})
	if _, err := svc.RepairSQL(context.Background(), "q", "SELECT 1", "boom", qc); err == nil {
		t.Error("repair accepted unsafe SQL")
	}
}

// The prompt must forbid the two behaviours that produced wrong or broken
// answers: correlated subqueries, and inventing sector membership.
func TestPromptForbidsCorrelatedSubqueriesAndInventedFacts(t *testing.T) {
	llm := &stubLLM{reply: "SELECT symbol FROM equities WHERE symbol = 'MTNGH' LIMIT 5"}
	svc := NewQueryService(llm)
	if _, err := svc.GenerateSQL(context.Background(), "q", qc); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"NO CORRELATED SUBQUERIES",
		"OVER (PARTITION BY symbol)",
		"LATEST ON trading_date PARTITION BY symbol",
		"must NOT invent or recall tickers",
	} {
		if !strings.Contains(llm.prompt, want) {
			t.Errorf("prompt missing %q", want)
		}
	}
}

// Sector membership can't come from QuestDB, so it travels in the prompt.
// Without it the model invented tickers; with it, the list is verifiable.
func TestSectorBlockGroupsAndSorts(t *testing.T) {
	llm := &stubLLM{reply: "SELECT symbol FROM equities WHERE symbol IN ('CAL','GCB') LIMIT 50"}
	svc := NewQueryService(llm)
	ctxWithSectors := QueryContext{
		DataAsOf: asOf,
		Sectors: map[string]string{
			"GCB": "Banking", "CAL": "Banking", "ACCESS": "Banking",
			"MTNGH": "Telecommunications", "SIC": "Insurance",
		},
	}

	if _, err := svc.GenerateSQL(context.Background(), "bank stocks", ctxWithSectors); err != nil {
		t.Fatalf("GenerateSQL: %v", err)
	}

	// Grouped by sector, symbols sorted — a stable prompt keeps the
	// fallback client's per-prompt dedup working.
	if !strings.Contains(llm.prompt, "Banking: ACCESS, CAL, GCB") {
		t.Errorf("banking line missing or unsorted:\n%s", llm.prompt)
	}
	if !strings.Contains(llm.prompt, "Insurance: SIC") ||
		!strings.Contains(llm.prompt, "Telecommunications: MTNGH") {
		t.Error("other sectors missing")
	}
	// Sectors sort alphabetically: Banking before Insurance before Telecoms.
	bank := strings.Index(llm.prompt, "Banking:")
	ins := strings.Index(llm.prompt, "Insurance:")
	tel := strings.Index(llm.prompt, "Telecommunications:")
	if !(bank < ins && ins < tel) {
		t.Errorf("sectors not in sorted order: %d %d %d", bank, ins, tel)
	}
	if !strings.Contains(llm.prompt, "every symbol you name must come") {
		t.Error("prompt should forbid inventing tickers outside the list")
	}
}

// With no mapping supplied the block vanishes rather than emitting an
// empty heading that implies sectors are unknown for every symbol.
func TestSectorBlockOmittedWhenEmpty(t *testing.T) {
	llm := &stubLLM{reply: "SELECT symbol FROM equities WHERE symbol = 'MTNGH' LIMIT 5"}
	svc := NewQueryService(llm)
	if _, err := svc.GenerateSQL(context.Background(), "q", QueryContext{DataAsOf: asOf}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(llm.prompt, "SECTOR MEMBERSHIP") {
		t.Error("empty sector map should not render a heading")
	}
}

// The repair prompt carries the sector list too — otherwise a retry can
// lose the grounding the first attempt had.
func TestRepairPromptKeepsSectorList(t *testing.T) {
	llm := &stubLLM{reply: "SELECT symbol FROM equities WHERE symbol IN ('GCB') LIMIT 50"}
	svc := NewQueryService(llm)
	ctxWithSectors := QueryContext{DataAsOf: asOf, Sectors: map[string]string{"GCB": "Banking"}}

	if _, err := svc.RepairSQL(context.Background(), "banks", "SELECT 1 WHERE x", "boom", ctxWithSectors); err != nil {
		t.Fatalf("RepairSQL: %v", err)
	}
	if !strings.Contains(llm.prompt, "Banking: GCB") {
		t.Error("repair prompt dropped the sector list")
	}
}
