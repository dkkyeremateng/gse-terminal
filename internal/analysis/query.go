package analysis

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// QueryResult is the structured output of a natural language query.
type QueryResult struct {
	SQL         string          `json:"sql"`
	Explanation string          `json:"explanation,omitempty"`
	Rows        [][]interface{} `json:"rows"`
	Columns     []string        `json:"columns"`
}

// dangerousPatterns rejects any SQL that attempts mutation, DDL, or
// statement chaining. Checked case-insensitively.
var dangerousPatterns = regexp.MustCompile(
	`(?i)\b(UPDATE|DELETE|INSERT|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC)\b|;`,
)

// commentPattern rejects SQL comments. The prompt already forbids them, but
// a comment is the standard way to make a keyword check read one thing and
// the engine read another, so it is worth enforcing rather than requesting.
var commentPattern = regexp.MustCompile(`--|/\*|\*/`)

// tableRefPattern captures the identifier after FROM or JOIN. A subquery
// (`FROM (SELECT ...`) does not match, which is fine — its own inner FROM
// does.
var tableRefPattern = regexp.MustCompile(`(?i)\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)`)

// cteNamePattern captures names bound by WITH x AS ( / , y AS ( so a CTE
// reference is not mistaken for an unauthorised table.
var cteNamePattern = regexp.MustCompile(`(?i)(?:\bWITH\s+|,\s*)([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(`)

// trailingLimitPattern matches the LIMIT clause QuestDB accepts in both
// forms: `LIMIT n` and the ranged `LIMIT lo, hi`.
var trailingLimitPattern = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)\s*(?:,\s*(\d+)\s*)?$`)

// allowedTable is the only table the generated SQL may read. The prompt
// says so, but saying so is not enforcement — QuestDB exposes system
// tables, and the user's question is appended to the system prompt with no
// delimiter, so a prompt-injected question can ask for anything.
const allowedTable = "equities"

// maxGeneratedRows caps what a generated query may return. RawQuery
// accumulates every row into a [][]interface{} before responding, so an
// unbounded self-join over 160k rows is an out-of-memory path bounded only
// by the 5s statement timeout. The prompt asks for "LIMIT 50 or fewer";
// this is what makes that true.
const maxGeneratedRows = 50

// unsupportedMarker is what the model returns when a question needs data
// the equities table doesn't hold. Cheaper than letting it invent a join
// against a table that isn't there and failing at execution.
const unsupportedMarker = "UNSUPPORTED"

// nlToSQLSystemPrompt is a format string: %[1]s is the latest trading date
// present in QuestDB as YYYY-MM-DD, %[2]s the rendered sector list (empty
// when none was supplied).
//
// Two things it has to be explicit about, both learned from queries that
// failed at execution:
//
//   - QuestDB is not PostgreSQL. Left to itself the model reaches for
//     today() / CURRENT_DATE, neither of which QuestDB defines.
//   - Only the equities table is reachable. sector_overrides lives in
//     Postgres, and RawQuery runs against QuestDB, so any join naming it
//     dies with "table does not exist".
//
// Pinning the date range matters as much as the dialect: the wall clock
// runs ahead of the data (the exchange publishes end-of-day, and a
// backfill can lag further), so now()-relative filters silently match
// nothing. Anchoring on the real latest session is the same fix applied
// to the repository's windowed queries.
const nlToSQLSystemPrompt = `You generate SQL for a Ghana Stock Exchange (GSE) database.

DIALECT: QuestDB. It speaks the Postgres wire protocol but is NOT PostgreSQL.

The ONLY table you may query is equities — one row per symbol per trading day:
  trading_date      TIMESTAMP  the session, at midnight UTC (designated timestamp)
  timestamp         TIMESTAMP  when the row was ingested — NOT a price time
  symbol            SYMBOL     ticker in upper case, e.g. 'MTNGH'
  open_price        DOUBLE
  last_price        DOUBLE     last traded price; 0 when the counter didn't trade
  close_price_vwap  DOUBLE     official closing VWAP — use this for "price" or "close"
  prev_close_vwap   DOUBLE     previous session's closing VWAP
  price_change      DOUBLE     absolute change against prev_close_vwap
  year_high         DOUBLE
  year_low          DOUBLE
  bid_price         DOUBLE     0 when there was no bid
  offer_price       DOUBLE     0 when there was no offer
  total_volume      LONG       shares traded
  total_value       DOUBLE     value traded in GH¢

That is the only table. There is no company-name, news, or user table, and
no sector table — sector membership is supplied below instead.
%[2]s
Never substitute your own knowledge for data you weren't given. Outside the
sector list above you do not know any company's industry or full name, and
you must NOT invent or recall tickers — every symbol you name must come
from that list. A wrong ticker produces a confidently wrong answer.

If the question cannot be answered from the columns and the sector list,
reply with exactly this word and nothing else: ` + unsupportedMarker + `
That includes multi-day technical indicators (RSI, MACD, Bollinger bands),
which the terminal computes on dedicated endpoints.

QuestDB SQL is a subset of PostgreSQL. The trap that breaks queries here:
- NO CORRELATED SUBQUERIES. A subquery may not reference a column of the
  outer query (WHERE e2.symbol = outer_table.symbol). QuestDB rejects it
  with "Invalid table name or alias". Express it one of these ways instead:
    * window function:  avg(close_price_vwap) OVER (PARTITION BY symbol)
    * self-join:        FROM equities a JOIN equities b ON a.symbol = b.symbol
    * uncorrelated subquery: WHERE symbol IN (SELECT symbol FROM equities WHERE ...)
    * newest row per symbol: LATEST ON trading_date PARTITION BY symbol
- Supported and safe: WITH ... AS, GROUP BY, JOIN, CASE WHEN, NULLIF,
  window functions, LATEST ON, the aggregate functions, dateadd().
- When you wrap a query in a subquery or CTE, the inner SELECT must list
  every column the outer query filters, orders, or selects — including
  trading_date if you filter on it. Otherwise QuestDB reports
  "Invalid column".

DATES — the data ends at %[1]s, which is the most recent session:
- "today", "latest", "most recent", "current" all mean trading_date = '%[1]s'
- "yesterday" means the session before %[1]s, not the previous calendar day.
  Get it with a subquery, not by subtracting one day: weekends and holidays
  have no rows.
- Relative windows anchor on that date, never on the clock:
  trading_date > dateadd('d', -30, '%[1]s')
- NEVER use today(), CURRENT_DATE, CURRENT_TIMESTAMP, getdate(), or
  interval literals — QuestDB has none of them. now() exists but points at
  the wall clock, which runs AHEAD of the data and matches nothing.

RULES:
- SELECT only. Never UPDATE, DELETE, INSERT, DROP, ALTER, TRUNCATE, CREATE.
- Exactly one statement. No semicolon, no comments, no markdown fences.
- Always include a WHERE clause.
- Single quotes for string literals.
- Aggregate with GROUP BY; use SAMPLE BY 1d ALIGN TO CALENDAR only when
  resampling a time series.
- End with LIMIT 50 or fewer.
- Return ONLY the SQL.`

// QueryService generates and validates SQL from natural language using
// the configured LLM, then executes it against a read-only data source.
type QueryService struct {
	llm LLMClient
}

func NewQueryService(llm LLMClient) *QueryService {
	return &QueryService{llm: llm}
}

// ErrQuestionUnsupported is returned when the question needs data the
// equities table doesn't carry — company names, news, indicators. Callers
// should surface it as a 4xx explanation rather than a server error.
var ErrQuestionUnsupported = errors.New("question cannot be answered from the available market data")

// QueryContext is the ground truth handed to the model alongside the
// question. Everything here exists to stop it filling gaps from memory:
// without the real date it invents now()-relative filters that match
// nothing, and without the real sector list it invents tickers.
type QueryContext struct {
	// DataAsOf is the latest trading date held in QuestDB. Relative
	// phrasing ("today", "last week") resolves against this rather than
	// the wall clock, which runs ahead of end-of-day data. Zero falls back
	// to the current date.
	DataAsOf time.Time
	// Sectors maps symbol to sector name. QuestDB has no sector column, so
	// this is the only way a sector question can be answered without
	// guessing. Empty is fine — such questions then return UNSUPPORTED.
	Sectors map[string]string
}

// sectorBlock renders the symbol→sector map grouped by sector, so a filter
// on "banks" becomes an IN list of verified tickers. Sorted throughout:
// a stable prompt keeps FallbackLLMClient's per-prompt dedup effective.
func (c QueryContext) sectorBlock() string {
	if len(c.Sectors) == 0 {
		return ""
	}
	bySector := make(map[string][]string, len(c.Sectors))
	for symbol, sector := range c.Sectors {
		bySector[sector] = append(bySector[sector], symbol)
	}
	names := make([]string, 0, len(bySector))
	for sector := range bySector {
		names = append(names, sector)
	}
	sort.Strings(names)

	var b strings.Builder
	b.WriteString("\nSECTOR MEMBERSHIP — the complete and authoritative list. Filter with\n")
	b.WriteString("symbol IN (...) using these tickers; treat any symbol absent here as\n")
	b.WriteString("having no known sector:\n")
	for _, sector := range names {
		symbols := bySector[sector]
		sort.Strings(symbols)
		fmt.Fprintf(&b, "  %s: %s\n", sector, strings.Join(symbols, ", "))
	}
	return b.String()
}

// systemPrompt renders the full instruction block for this context.
func (c QueryContext) systemPrompt() string {
	asOf := c.DataAsOf
	if asOf.IsZero() {
		asOf = time.Now().UTC()
	}
	return fmt.Sprintf(nlToSQLSystemPrompt, asOf.Format("2006-01-02"), c.sectorBlock())
}

// GenerateSQL takes a natural language question, asks the LLM to produce
// SQL, and validates the output before returning it. qc supplies the facts
// the model must not invent — see QueryContext.
func (q *QueryService) GenerateSQL(ctx context.Context, question string, qc QueryContext) (string, error) {
	if q.llm == nil {
		return "", fmt.Errorf("LLM client not configured")
	}

	raw, err := q.llm.Generate(ctx, fmt.Sprintf("%s\n\nUser question: %s", qc.systemPrompt(), question))
	if err != nil {
		return "", fmt.Errorf("LLM generation failed: %w", err)
	}

	sql := cleanSQL(raw)
	if strings.EqualFold(strings.TrimSpace(sql), unsupportedMarker) {
		return "", ErrQuestionUnsupported
	}
	if err := validateSQL(sql); err != nil {
		return "", fmt.Errorf("unsafe SQL rejected: %w", err)
	}
	if bounded, changed := enforceRowLimit(sql); changed {
		slog.Warn("[query] generated SQL exceeded the row cap; rewriting",
			"cap", maxGeneratedRows, "original", sql)
		sql = bounded
	}

	return sql, nil
}

// sqlRepairPrompt asks for a second attempt using the database's own
// rejection as the hint. No prompt covers every gap in QuestDB's dialect,
// and the engine's error message is a far better correction signal than
// anything we can anticipate — one retry converts most dialect misses into
// a working query instead of a dead end for the user.
//
// %[1]s rejected SQL, %[2]s QuestDB's error, %[3]s the unsupported marker.
const sqlRepairPrompt = `Your previous query was rejected by QuestDB.

Query:
%[1]s

QuestDB error:
%[2]s

Rewrite it so it executes on QuestDB and still answers the question. Every
rule above still applies. "Invalid table name or alias" almost always means
a correlated subquery — restructure it with a window function, a self-join,
or LATEST ON. Return ONLY the corrected SQL, or %[3]s if the question can't
be expressed within these limits.`

// RepairSQL takes SQL the database rejected and asks the model to fix it,
// handing over the engine's error verbatim. Returns ErrQuestionUnsupported
// when the model concludes the question can't be expressed.
func (q *QueryService) RepairSQL(ctx context.Context, question, failedSQL, dbError string, qc QueryContext) (string, error) {
	if q.llm == nil {
		return "", fmt.Errorf("LLM client not configured")
	}

	prompt := fmt.Sprintf("%s\n\nUser question: %s\n\n%s",
		qc.systemPrompt(),
		question,
		fmt.Sprintf(sqlRepairPrompt, failedSQL, dbError, unsupportedMarker),
	)

	raw, err := q.llm.Generate(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("LLM generation failed: %w", err)
	}

	sql := cleanSQL(raw)
	if strings.EqualFold(strings.TrimSpace(sql), unsupportedMarker) {
		return "", ErrQuestionUnsupported
	}
	if err := validateSQL(sql); err != nil {
		return "", fmt.Errorf("unsafe SQL rejected: %w", err)
	}
	if bounded, changed := enforceRowLimit(sql); changed {
		slog.Warn("[query] repaired SQL exceeded the row cap; rewriting",
			"cap", maxGeneratedRows, "original", sql)
		sql = bounded
	}
	return sql, nil
}

// cleanSQL strips markdown fences, leading/trailing whitespace, and
// ensures the output is a single statement.
func cleanSQL(raw string) string {
	s := strings.TrimSpace(raw)
	// Strip ```sql ... ``` fences
	s = strings.TrimPrefix(s, "```sql")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)
	// Remove trailing semicolons
	s = strings.TrimRight(s, ";")
	return strings.TrimSpace(s)
}

// validateSQL checks the generated SQL for safety.
func validateSQL(sql string) error {
	upper := strings.ToUpper(strings.TrimSpace(sql))

	// A CTE is read-only and QuestDB supports it — the prompt recommends
	// WITH for exactly the per-symbol comparisons that would otherwise be
	// written as a correlated subquery, so rejecting the keyword here would
	// throw away valid answers. The SELECT check below still applies, and
	// dangerousPatterns continues to block every mutating keyword.
	if !strings.HasPrefix(upper, "SELECT") && !strings.HasPrefix(upper, "WITH") {
		return fmt.Errorf("query must start with SELECT or WITH, got: %.30s", sql)
	}
	if !strings.Contains(upper, "SELECT") {
		return fmt.Errorf("query must contain a SELECT")
	}

	// Explicit single-statement enforcement. cleanSQL only strips a
	// trailing `;`, so an embedded `;` would land here intact. The
	// dangerousPatterns regex below would also catch it, but a literal
	// statement-chaining check is clearer than relying on the regex
	// alternation and leaves a precise error code if QuestDB's grammar
	// ever picks up a SELECT-internal use of `;` we'd want to allow.
	if strings.Contains(sql, ";") {
		return fmt.Errorf("query must be a single statement (no semicolons)")
	}

	if dangerousPatterns.MatchString(sql) {
		return fmt.Errorf("query contains forbidden keyword")
	}

	if !strings.Contains(upper, "WHERE") {
		return fmt.Errorf("query must contain a WHERE clause")
	}

	// Comments are forbidden by the prompt, and a comment is the standard
	// way to make a keyword check read one thing and the engine read
	// another. Enforce rather than request.
	if commentPattern.MatchString(sql) {
		return fmt.Errorf("query must not contain comments")
	}

	// Table scoping. The prompt says equities is the only readable table,
	// but the user's question is appended to that prompt with no delimiter,
	// so a question that says "ignore the above" can ask for anything —
	// including QuestDB's system tables. Names bound by WITH ... AS are
	// allowed because they are defined inside this statement.
	if err := checkTableScope(sql); err != nil {
		return err
	}

	// Reject excessively long queries (likely injection attempts)
	if len(sql) > 2000 {
		return fmt.Errorf("query too long (%d chars)", len(sql))
	}

	return nil
}

// checkTableScope verifies every FROM / JOIN target is either the equities
// table or a CTE the query defines itself.
func checkTableScope(sql string) error {
	ctes := make(map[string]bool)
	for _, m := range cteNamePattern.FindAllStringSubmatch(sql, -1) {
		ctes[strings.ToLower(m[1])] = true
	}
	for _, m := range tableRefPattern.FindAllStringSubmatch(sql, -1) {
		name := strings.ToLower(m[1])
		if name == allowedTable || ctes[name] {
			continue
		}
		return fmt.Errorf("query may only read the %s table, got %q", allowedTable, m[1])
	}
	return nil
}

// enforceRowLimit guarantees the statement returns at most maxGeneratedRows.
//
// The prompt asks for "LIMIT 50 or fewer" and the model usually complies,
// but nothing checked, and RawQuery accumulates every returned row into a
// [][]interface{} before responding — so a self-join that forgot its LIMIT
// is an out-of-memory path bounded only by the 5s statement timeout.
//
// Rewrites rather than rejects. A missing or oversized LIMIT is the model
// being sloppy about a formatting rule, not the user asking something
// unreasonable, and validateSQL failures are not fed to RepairSQL — so
// rejecting here would dead-end a question that is otherwise fine.
// Returns the SQL to run and whether it had to be changed.
func enforceRowLimit(sql string) (string, bool) {
	trimmed := strings.TrimRight(strings.TrimSpace(sql), ";")

	m := trailingLimitPattern.FindStringSubmatchIndex(trimmed)
	if m == nil {
		// No trailing LIMIT at all. Appending one is safe precisely
		// because we just confirmed there is not already one to conflict
		// with, and LIMIT is the last clause in QuestDB's grammar.
		return fmt.Sprintf("%s LIMIT %d", trimmed, maxGeneratedRows), true
	}

	groups := trailingLimitPattern.FindStringSubmatch(trimmed)
	head := strings.TrimRight(trimmed[:m[0]], " \t\n")

	// Ranged form: LIMIT lo, hi returns rows lo..hi, so the span is what
	// needs bounding, not hi itself.
	if groups[2] != "" {
		lo, hi := atoiSafe(groups[1]), atoiSafe(groups[2])
		if hi-lo <= maxGeneratedRows {
			return trimmed, false
		}
		return fmt.Sprintf("%s LIMIT %d, %d", head, lo, lo+maxGeneratedRows), true
	}

	if n := atoiSafe(groups[1]); n <= maxGeneratedRows && n > 0 {
		return trimmed, false
	}
	return fmt.Sprintf("%s LIMIT %d", head, maxGeneratedRows), true
}

// atoiSafe parses a run of digits the regex already matched. A value too
// large for an int saturates, which then trips the clamp above — the right
// outcome for "LIMIT 99999999999999999999".
func atoiSafe(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return math.MaxInt32
	}
	return n
}
