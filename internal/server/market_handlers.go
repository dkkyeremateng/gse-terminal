package server

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"regexp"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/teckdroids/ges-data-engine/internal/analysis"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// MoversMinVolume is the absolute volume floor applied to TopGainers /
// TopLosers rankings. A 1,000-share day shouldn't qualify as a "top
// mover" — without this floor a thinly-traded symbol with a 6% move
// crowds out actual liquid stocks. Tuned for GSE volumes; revisit if
// average daily volume profile shifts.
const MoversMinVolume int64 = 2_000

// rankMovers sorts the input snapshot by percent change in both directions
// and returns the qualifying gainers / losers — sign-correct and above the
// supplied volume floor. Pure function so the ranking logic can be tested
// without spinning up the cache or repository.
func rankMovers(items []repository.MarketSummaryItem, minVolume int64) (gainers, losers []repository.MarketSummaryItem) {
	g := append([]repository.MarketSummaryItem(nil), items...)
	l := append([]repository.MarketSummaryItem(nil), items...)

	sort.SliceStable(g, func(i, j int) bool {
		return g[i].PercentChange > g[j].PercentChange
	})
	sort.SliceStable(l, func(i, j int) bool {
		return l[i].PercentChange < l[j].PercentChange
	})

	for _, row := range g {
		if row.PercentChange > 0 && row.Volume >= minVolume {
			gainers = append(gainers, row)
		}
	}
	for _, row := range l {
		if row.PercentChange < 0 && row.Volume >= minVolume {
			losers = append(losers, row)
		}
	}
	return gainers, losers
}

// symbolRe validates that a ticker symbol starts with an uppercase letter
// and continues with uppercase letters or digits, optionally in
// space- or hyphen-separated groups. GSE tickers are alphabetic-prefixed
// — "MTNGH", "GCB", "EGL" — and a leading digit was almost certainly an
// LLM hallucination or typo. Rejecting all-numeric "symbols" prevents
// nonsense queries from bouncing through the data layer and returning
// empty rows. Applied to all user-supplied symbol parameters before
// they reach the database layer.
//
// The separator groups matter: the exchange lists preference shares and
// rights issues under tickers that are not a single alphanumeric run
// — "SCB PREF", "CAL PREF", "GGBL RE", "ALW RE" — and one historical
// listing is hyphenated, "SG-SSB". A stricter pattern rejected all of
// them at the handler, so 4,458 rows of real history could not be
// queried at all. A separator must sit between two alphanumeric runs, so
// leading, trailing and repeated separators are still rejected.
var symbolRe = regexp.MustCompile(`^[A-Z][A-Z0-9]*(?:[ -][A-Z0-9]+)*$`)

// symbolMaxLen bounds the whole symbol. The longest real GSE ticker is
// well under this; the cap only stops an unbounded string reaching the
// query layer.
const symbolMaxLen = 16

func validateSymbol(sym string) bool {
	return len(sym) <= symbolMaxLen && symbolRe.MatchString(sym)
}

func (s *Server) HandleGetHistory(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("symbol")))
	interval := r.URL.Query().Get("interval")

	if symbol == "" || interval == "" {
		http.Error(w, "Missing symbol or interval", http.StatusBadRequest)
		return
	}
	if !validateSymbol(symbol) {
		respondError(w, http.StatusBadRequest, "Invalid symbol")
		return
	}
	// The interval is interpolated into the cache key below, so check it
	// here rather than relying on GetOHLC to reject it -- by then the
	// caller-controlled string has already been used to build a Redis key.
	if !repository.ValidInterval(interval) {
		respondError(w, http.StatusBadRequest, "Invalid interval")
		return
	}

	key := fmt.Sprintf("gse:data:history:%s:%s", symbol, interval)
	bytes, err := s.cachedJSONBytes(r.Context(), key, func() (interface{}, error) {
		return s.qdbRepo.GetOHLC(r.Context(), symbol, interval)
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Query failed")
		return
	}
	writeCachedJSON(w, bytes)
}

// cachedSymbols returns the symbol list directly from the cache (or QuestDB
// on a miss), shared by every handler that needs it.
func (s *Server) cachedSymbols(ctx context.Context) ([]string, error) {
	bytes, err := s.cachedJSONBytes(ctx, "gse:data:symbols", func() (interface{}, error) {
		return s.qdbRepo.GetSymbols(ctx)
	})
	if err != nil {
		return nil, err
	}
	var out []string
	if err := json.Unmarshal(bytes, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Server) HandleGetSymbols(w http.ResponseWriter, r *http.Request) {
	bytes, err := s.cachedJSONBytes(r.Context(), "gse:data:symbols", func() (interface{}, error) {
		return s.qdbRepo.GetSymbols(r.Context())
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to fetch symbols")
		return
	}
	writeCachedJSON(w, bytes)
}

// HandleGetCompare returns OHLC series for up to 4 symbols in a single
// response so the frontend can render a comparison overlay without firing
// multiple history requests in parallel.
func (s *Server) HandleGetCompare(w http.ResponseWriter, r *http.Request) {
	symbolsParam := r.URL.Query().Get("symbols")
	interval := r.URL.Query().Get("interval")
	if interval == "" {
		interval = "1d"
	}
	if !repository.ValidInterval(interval) {
		respondError(w, http.StatusBadRequest, "Invalid interval")
		return
	}
	if symbolsParam == "" {
		respondError(w, http.StatusBadRequest, "Missing symbols")
		return
	}

	raw := strings.Split(symbolsParam, ",")
	if len(raw) > 4 {
		respondError(w, http.StatusBadRequest, "Compare supports a maximum of 4 symbols")
		return
	}

	// Cache hits are honoured per-symbol; misses are coalesced into a single
	// batched query so a 4-symbol compare costs at most ONE QuestDB round
	// trip instead of four. Previously this loop fired N sequential queries.
	cached := make(map[string][]repository.OHLC, len(raw))
	var miss []string
	for _, sym := range raw {
		sym = strings.ToUpper(strings.TrimSpace(sym))
		if sym == "" {
			continue
		}
		if !validateSymbol(sym) {
			respondError(w, http.StatusBadRequest, fmt.Sprintf("Invalid symbol: %s", sym))
			return
		}
		key := fmt.Sprintf("gse:data:history:%s:%s", sym, interval)
		if bytes, err := s.redisRepo.Get(r.Context(), key); err == nil && len(bytes) > 0 {
			var data []repository.OHLC
			if err := json.Unmarshal(bytes, &data); err == nil {
				if len(data) > 0 {
					cached[sym] = data
					continue
				}
			}
		}
		miss = append(miss, sym)
	}

	if len(miss) > 0 {
		batch, err := s.qdbRepo.GetOHLCBatch(r.Context(), miss, interval, time.Time{})
		if err != nil {
			LoggerFromCtx(r.Context()).Warn("compare batch fetch failed", "symbols", miss, "error", err)
		}
		for _, sym := range miss {
			data := batch[sym]
			cached[sym] = data
			// Best-effort write-through to the per-symbol cache so a follow-up
			// /v1/history hit reuses the same payload. Tracked via
			// goBackground so Shutdown waits for these to finish.
			if encoded, err := json.Marshal(data); err == nil {
				key := fmt.Sprintf("gse:data:history:%s:%s", sym, interval)
				b := encoded
				k := key
				s.goBackground(func(bgCtx context.Context) {
					cctx, cancel := context.WithTimeout(bgCtx, 5*time.Second)
					defer cancel()
					s.redisRepo.SetWithTTL(cctx, k, b, dataCacheTTL)
				})
			}
		}
	}

	if len(cached) == 0 {
		respondError(w, http.StatusNotFound, "No data for any requested symbol")
		return
	}
	respondJSON(w, cached)
}

// HandleGetBriefing returns the latest daily market briefing + per-symbol insights.
func (s *Server) HandleGetBriefing(w http.ResponseWriter, r *http.Request) {
	key := "gse:data:briefing"
	bytes, err := s.cachedJSONBytes(r.Context(), key, func() (interface{}, error) {
		briefing, err := s.pgRepo.GetLatestBriefing(r.Context())
		if err != nil {
			if isBriefingEmptyResult(err) {
				return emptyBriefingPayload(), nil
			}
			return nil, err
		}
		return briefing, nil
	})
	if err != nil {
		respondError(w, http.StatusNotFound, "No briefing available yet")
		return
	}
	writeCachedJSON(w, bytes)
}

func isBriefingEmptyResult(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

func emptyBriefingPayload() map[string]any {
	return map[string]any{
		"summary":  nil,
		"insights": []any{},
	}
}

// HandleNaturalQuery accepts a natural language question, generates safe SQL
// via the LLM, executes it against QuestDB, and returns the results.
// Pro/admin gated.
func (s *Server) HandleNaturalQuery(w http.ResponseWriter, r *http.Request) {
	// Cap request body so a client can't OOM the server with a multi-GB
	// JSON blob before we even get to parse validation. 16 KiB is plenty
	// for a natural-language question — anything longer is almost
	// certainly hostile.
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var body struct {
		Question string `json:"question"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields() // surface contract drift instead of silently dropping fields
	if err := dec.Decode(&body); err != nil || strings.TrimSpace(body.Question) == "" {
		respondError(w, http.StatusBadRequest, "Missing or invalid question")
		return
	}

	// Anchor relative phrasing ("today", "last week") to the newest session
	// we actually hold — the wall clock runs ahead of end-of-day data, so a
	// now()-relative filter matches nothing. A lookup failure is non-fatal:
	// GenerateSQL falls back to the current date.
	dataAsOf, err := s.qdbRepo.GetLastIngestionTime(r.Context())
	if err != nil {
		LoggerFromCtx(r.Context()).Warn("[query] latest trading date lookup failed", "error", err)
	}

	queryCtx := analysis.QueryContext{
		DataAsOf: dataAsOf,
		// QuestDB has no sector column, so sector membership has to travel
		// with the prompt or the model fills it in from memory — which it
		// did, naming tickers that aren't listed on the GSE. Seed plus any
		// admin overrides, narrowed to symbols that actually have rows.
		Sectors: s.sectorsForQuery(r.Context()),
	}

	querySvc := analysis.NewQueryService(s.insightSvc.LLM())
	sql, err := querySvc.GenerateSQL(r.Context(), body.Question, queryCtx)
	if err != nil {
		// A question outside the schema is the user's to fix, not a bug —
		// say so plainly instead of echoing an internal error.
		if errors.Is(err, analysis.ErrQuestionUnsupported) {
			respondError(w, http.StatusUnprocessableEntity,
				"That question needs data this terminal doesn't hold — try one about prices, volume, or value for a symbol or date range.")
			return
		}
		respondError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	// Execute the validated SQL against the read-only QuestDB pool with timeout
	logger := LoggerFromCtx(r.Context())
	rows, err := s.runGeneratedQuery(r.Context(), sql)
	if err != nil {
		// QuestDB rejected it. Its error names the actual problem far more
		// precisely than the prompt can anticipate, so hand it back for one
		// repair attempt before giving up on the question.
		logger.Warn("[query] execution error, attempting repair", "sql", sql, "error", err)

		repaired, rerr := querySvc.RepairSQL(r.Context(), body.Question, sql, err.Error(), queryCtx)
		if rerr != nil {
			if errors.Is(rerr, analysis.ErrQuestionUnsupported) {
				respondError(w, http.StatusUnprocessableEntity,
					"That question can't be expressed against this data set — try one about prices, volume, or value for a symbol or date range.")
				return
			}
			logger.Warn("[query] repair failed", "error", rerr)
			respondError(w, http.StatusUnprocessableEntity, "The generated query wasn't valid for this database: "+err.Error())
			return
		}

		rows, err = s.runGeneratedQuery(r.Context(), repaired)
		if err != nil {
			logger.Warn("[query] repaired query also failed", "sql", repaired, "error", err)
			respondError(w, http.StatusUnprocessableEntity, "The generated query wasn't valid for this database: "+err.Error())
			return
		}
		logger.Info("[query] repair succeeded", "sql", repaired)
		sql = repaired
	}

	respondJSON(w, map[string]interface{}{
		"sql":     sql,
		"columns": rows.Columns,
		"rows":    rows.Rows,
	})
}

// sectorsForQuery returns the symbol→sector map handed to the NL→SQL
// prompt, narrowed to symbols QuestDB actually holds so the model can't
// filter on a delisted or never-traded ticker. Falls back to the full
// mapping when the symbol list is unavailable — a slightly wider list
// beats dropping sector support for the request.
func (s *Server) sectorsForQuery(ctx context.Context) map[string]string {
	all := repository.AllSectorMappings()
	symbols, err := s.cachedSymbols(ctx)
	if err != nil || len(symbols) == 0 {
		return all
	}
	out := make(map[string]string, len(symbols))
	for _, sym := range symbols {
		if sector, ok := all[sym]; ok {
			out[sym] = sector
		}
	}
	return out
}

// runGeneratedQuery executes one LLM-generated statement against QuestDB
// under its own 5s budget. Each attempt gets a fresh context so a repair
// isn't racing the deadline the first attempt already spent.
func (s *Server) runGeneratedQuery(ctx context.Context, sql string) (*repository.RawQueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return s.qdbRepo.RawQuery(ctx, sql)
}

func (s *Server) HandleGetSymbolsHTML(w http.ResponseWriter, r *http.Request) {
	symbols, err := s.cachedSymbols(r.Context())
	if err != nil {
		http.Error(w, "Failed to fetch symbols", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html")
	for _, sym := range symbols {
		fmt.Fprintf(w, "<option value=\"%s\"></option>\n", sym)
	}
}

// RSSItem / RSSNews are the wire shapes used by HandleGetNews and
// HandleGetMarketNews to decode Google News' RSS feed and re-emit a
// JSON-friendly response with sentiment classification.
type RSSItem struct {
	Title          string `xml:"title" json:"title"`
	Link           string `xml:"link" json:"link"`
	PubDate        string `xml:"pubDate" json:"pubDate"`
	Classification string `xml:"-" json:"classification"`
}

type RSSNews struct {
	Items []RSSItem `xml:"channel>item" json:"items"`
}

func classifyHeadlines(items []RSSItem) {
	for i := range items {
		score := analysis.SimpleSentiment(items[i].Title)
		switch {
		case score > 0:
			items[i].Classification = "POSITIVE"
		case score < 0:
			items[i].Classification = "NEGATIVE"
		default:
			items[i].Classification = "NEUTRAL"
		}
	}
}

// dedupeNewsByTitle removes near-duplicate headlines that Google News
// surfaces when multiple outlets republish the same wire story. Match
// is case-insensitive, ignores extra whitespace, and strips any " - <source>"
// suffix Google News appends. First occurrence wins so the highest-ranked
// source survives when callers sort before deduping.
func dedupeNewsByTitle(items []RSSItem) []RSSItem {
	seen := make(map[string]struct{}, len(items))
	out := items[:0]
	for _, it := range items {
		t := it.Title
		if i := strings.LastIndex(t, " - "); i > 0 {
			t = t[:i]
		}
		key := strings.ToLower(strings.Join(strings.Fields(t), " "))
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, it)
	}
	return out
}

// sortNewsByPubDateDesc sorts items by PubDate, newest first. Google
// News RSS generally returns items in reverse chronological order
// already, but upstream ordering isn't a contract we can rely on — a
// user-visible "check back for newer headlines" feed shouldn't ever
// surface an older article above a newer one. Items with an
// unparseable PubDate sink to the bottom (treated as zero time).
// Uses RFC1123Z first (the Google News default) and falls back to
// RFC1123 for sources that omit the timezone offset.
func sortNewsByPubDateDesc(items []RSSItem) {
	parse := func(s string) time.Time {
		if t, err := time.Parse(time.RFC1123Z, s); err == nil {
			return t
		}
		if t, err := time.Parse(time.RFC1123, s); err == nil {
			return t
		}
		return time.Time{}
	}
	sort.SliceStable(items, func(i, j int) bool {
		return parse(items[i].PubDate).After(parse(items[j].PubDate))
	})
}

func (s *Server) HandleGetNews(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("symbol")))
	if symbol == "" {
		http.Error(w, "Missing symbol", http.StatusBadRequest)
		return
	}
	if !validateSymbol(symbol) {
		respondError(w, http.StatusBadRequest, "Invalid symbol")
		return
	}

	searchQuery := url.QueryEscape(fmt.Sprintf("%s stock Ghana", symbol))
	rssURL := fmt.Sprintf("https://news.google.com/rss/search?q=%s&hl=en-GH&gl=GH&ceid=GH:en", searchQuery)

	req, err := http.NewRequest("GET", rssURL, nil)
	if err != nil {
		http.Error(w, "Failed to create news request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		LoggerFromCtx(r.Context()).Error("News fetch error", "symbol", symbol, "error", err)
		http.Error(w, "Failed to fetch news feed", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		LoggerFromCtx(r.Context()).Warn("News feed status error", "symbol", symbol, "status", resp.StatusCode)
		http.Error(w, "News service unavailable", http.StatusServiceUnavailable)
		return
	}

	var news RSSNews
	if err := xml.NewDecoder(resp.Body).Decode(&news); err != nil {
		LoggerFromCtx(r.Context()).Error("XML decode error for news", "symbol", symbol, "error", err)
		http.Error(w, "Failed to parse news feed", http.StatusInternalServerError)
		return
	}

	sortNewsByPubDateDesc(news.Items)
	news.Items = dedupeNewsByTitle(news.Items)
	if len(news.Items) > 5 {
		news.Items = news.Items[:5]
	}
	classifyHeadlines(news.Items)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(news.Items)
}

// marketNewsCacheKey + marketNewsCacheTTL govern the Google News RSS cache.
// The upstream is rate-limited and prone to transient timeouts, so a short
// cache window both reduces blast radius on the news feed and keeps the
// "Top headlines" card filled when a single fetch errors.
const (
	marketNewsCacheKey = "gse:data:market-news"
	marketNewsCacheTTL = 10 * time.Minute
)

func (s *Server) HandleGetMarketNews(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Cache-first. Any populated cached value wins.
	if cached, err := s.redisRepo.Get(ctx, marketNewsCacheKey); err == nil && !isEmptyJSON(cached) {
		writeCachedJSON(w, cached)
		return
	}

	items, err := fetchMarketNews(ctx, s.httpClient)
	if err != nil {
		// Upstream blew up. Don't 500 — the news card is a polish surface,
		// not a core feature, and a console error on every dashboard load
		// is noise. Serve an empty list with 200 so the UI renders its
		// own empty state instead of a network error.
		LoggerFromCtx(ctx).Warn("Market news fetch error, serving empty", "error", err)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
		return
	}

	bytes, err := json.Marshal(items)
	if err != nil {
		LoggerFromCtx(ctx).Error("Market news marshal error", "error", err)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
		return
	}

	if !isEmptyJSON(bytes) {
		b := bytes
		s.goBackground(func(bgCtx context.Context) {
			writeCtx, cancel := context.WithTimeout(bgCtx, 5*time.Second)
			defer cancel()
			_ = s.redisRepo.SetWithTTL(writeCtx, marketNewsCacheKey, b, marketNewsCacheTTL)
		})
	}

	writeCachedJSON(w, bytes)
}

// fetchMarketNews pulls the GSE-tagged Google News RSS feed, sorts and
// dedupes it, caps to 10 items, and classifies sentiment. Extracted from
// the handler so the cache + fallback layer above stays small.
func fetchMarketNews(ctx context.Context, client *http.Client) ([]RSSItem, error) {
	rssURL := fmt.Sprintf(
		"https://news.google.com/rss/search?q=%s&hl=en-GH&gl=GH&ceid=GH:en",
		url.QueryEscape("Ghana Stock Exchange"),
	)
	req, err := http.NewRequestWithContext(ctx, "GET", rssURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upstream: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	var news RSSNews
	if err := xml.NewDecoder(resp.Body).Decode(&news); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	sortNewsByPubDateDesc(news.Items)
	news.Items = dedupeNewsByTitle(news.Items)
	if len(news.Items) > 10 {
		news.Items = news.Items[:10]
	}
	classifyHeadlines(news.Items)
	return news.Items, nil
}

func (s *Server) HandleGetMarketSummary(w http.ResponseWriter, r *http.Request) {
	bytes, err := s.cachedJSONBytes(r.Context(), "gse:data:market-summary", func() (interface{}, error) {
		return s.buildMarketOverview(r.Context())
	})
	if err != nil {
		LoggerFromCtx(r.Context()).Error("Market summary error", "error", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch market summary")
		return
	}
	writeCachedJSON(w, bytes)
}

// cachedMarketSummaryItems returns the raw `LATEST` snapshot from the
// equities table, cached. Shared by every handler that needs the full set
// (watchlist, ticker, market summary).
func (s *Server) cachedMarketSummaryItems(ctx context.Context) ([]repository.MarketSummaryItem, error) {
	bytes, err := s.cachedJSONBytes(ctx, "gse:data:market-snapshot", func() (interface{}, error) {
		return s.qdbRepo.GetMarketSummary(ctx)
	})
	if err != nil {
		return nil, err
	}
	var items []repository.MarketSummaryItem
	if err := json.Unmarshal(bytes, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// buildMarketOverview is the (uncached) shaped output that
// HandleGetMarketSummary serves. Extracted so the cache helper can call it.
func (s *Server) buildMarketOverview(ctx context.Context) (*repository.MarketOverview, error) {
	items, err := s.cachedMarketSummaryItems(ctx)
	if err != nil {
		return nil, err
	}

	// Filter out ghost/stale entries
	var validItems []repository.MarketSummaryItem
	for _, item := range items {
		if item.Symbol != "" && item.LastPrice > 0 {
			validItems = append(validItems, item)
		}
	}
	items = validItems

	filteredGainers, filteredLosers := rankMovers(items, MoversMinVolume)

	active := append([]repository.MarketSummaryItem(nil), items...)
	sort.SliceStable(active, func(i, j int) bool {
		return active[i].Volume > active[j].Volume
	})

	limit := func(l []repository.MarketSummaryItem, max int) []repository.MarketSummaryItem {
		if len(l) > max {
			return l[:max]
		}
		return l
	}

	overview := repository.MarketOverview{
		TopGainers:      limit(filteredGainers, 6),
		TopLosers:       limit(filteredLosers, 6),
		Active:          limit(active, 6),
		All:             items,
		MoversMinVolume: MoversMinVolume,
	}

	if ts, err := s.qdbRepo.GetLastIngestionTime(ctx); err == nil && !ts.IsZero() {
		overview.LastUpdated = &ts
	}

	return &overview, nil
}

// HandleExportStockData handles the CSV export for a given symbol.
func (s *Server) HandleExportStockData(w http.ResponseWriter, r *http.Request) {
	symbol := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "symbol")))
	if symbol == "" {
		http.Error(w, "Symbol required", http.StatusNotFound)
		return
	}
	// This was the one symbol-taking handler that skipped validation, which
	// let an arbitrary caller-controlled string become a Redis key
	// (gse:data:ticks:<anything>, cached for 6h) and a QuestDB scan.
	if !validateSymbol(symbol) {
		respondError(w, http.StatusBadRequest, "Invalid symbol")
		return
	}

	ctx := r.Context()
	key := fmt.Sprintf("gse:data:ticks:%s", symbol)
	bytes, err := s.cachedJSONBytes(ctx, key, func() (interface{}, error) {
		return s.qdbRepo.GetTickerData(ctx, symbol)
	})
	if err != nil {
		LoggerFromCtx(r.Context()).Error("Failed to fetch ticker data for export", "symbol", symbol, "error", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	var ticks []repository.Tick
	if err := json.Unmarshal(bytes, &ticks); err != nil {
		LoggerFromCtx(r.Context()).Error("Failed to decode cached ticker data", "symbol", symbol, "error", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	filename := fmt.Sprintf("%s_historical_data_%s.csv", symbol, time.Now().Format("2006-01-02"))
	w.Header().Set("Content-Type", "text/csv")
	// Quote the filename. Several real GSE tickers contain a space --
	// "SCB PREF", "CAL PREF", "GGBL RE" -- and an unquoted
	// Content-Disposition parameter ends at the first space, so browsers
	// were saving those exports as "SCB" with no extension.
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))

	writer := csv.NewWriter(w)
	defer writer.Flush()

	header := []string{
		"TradingDate", "Symbol", "YearHigh", "YearLow", "PrevCloseVWAP",
		"OpenPrice", "LastPrice", "ClosePriceVWAP", "PriceChange",
		"BidPrice", "OfferPrice", "TotalVolume", "TotalValue",
	}
	if err := writer.Write(header); err != nil {
		LoggerFromCtx(r.Context()).Error("Failed to write CSV header", "error", err)
		return
	}

	for _, t := range ticks {
		row := []string{
			t.TradingDate.Format(time.RFC3339),
			t.Symbol,
			fmt.Sprintf("%.4f", t.YearHigh),
			fmt.Sprintf("%.4f", t.YearLow),
			fmt.Sprintf("%.4f", t.PrevCloseVWAP),
			fmt.Sprintf("%.4f", t.OpenPrice),
			fmt.Sprintf("%.4f", t.LastPrice),
			fmt.Sprintf("%.4f", t.ClosePriceVWAP),
			fmt.Sprintf("%.4f", t.PriceChange),
			fmt.Sprintf("%.4f", t.BidPrice),
			fmt.Sprintf("%.4f", t.OfferPrice),
			strconv.FormatInt(t.TotalVolume, 10),
			fmt.Sprintf("%.4f", t.TotalValue),
		}
		if err := writer.Write(row); err != nil {
			LoggerFromCtx(r.Context()).Error("Failed to write CSV row", "error", err)
			return
		}
	}
}
