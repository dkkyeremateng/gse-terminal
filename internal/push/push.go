// Package push sends Web Push notifications via the VAPID protocol.
//
// The alerts evaluator calls SendToUser after each rule fires. The
// service looks up every active push subscription for that user and
// dispatches a notification to each. Stale endpoints (410 Gone from
// the push provider) are lazily cleaned up so the table doesn't
// accumulate dead rows.
//
// Dependencies are injected via interfaces so the alerts package
// stays decoupled from the repository and this package stays testable
// without a real Postgres pool.
package push

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// perUserPushTimeout caps how long a single user's fan-out can take.
// Without it, one user with multiple stalled subscriptions could eat
// the entire parent deadline (90s for upload-triggered digests),
// leaving later users in the loop completely undelivered. 10s is
// generous for a single round of webpush HTTP calls; legitimate
// providers respond in well under a second.
const perUserPushTimeout = 10 * time.Second

// Subscription mirrors repository.PushSubscription. Redeclared here so
// the push package doesn't import internal/repository (keeps the
// dependency graph acyclic).
type Subscription struct {
	Endpoint   string
	P256dh     string
	AuthSecret string
}

// SubscriptionStore is the narrow interface the push service needs.
// *repository.PostgresRepo satisfies it.
type SubscriptionStore interface {
	ListPushSubscriptions(ctx context.Context, userID int) ([]Subscription, error)
	DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error
	// ListWatchListsForPushSubscribers returns every user that has BOTH
	// at least one push subscription and at least one watchlist symbol.
	// Used by SendWatchListDigest to fan out the post-scrape notification
	// without sending to users who would have an empty body anyway.
	ListWatchListsForPushSubscribers(ctx context.Context) ([]UserWatchlist, error)
}

// UserWatchlist mirrors repository.UserWatchListRow. Redeclared here so the
// push package doesn't import internal/repository.
type UserWatchlist struct {
	UserID  int
	Symbols []string
}

// SymbolSnap is one row in the post-scrape snapshot. The collector builds
// these from the freshly-ingested live frame and hands the map to
// SendWatchListDigest. PercentChange is the day-over-day percent move.
type SymbolSnap struct {
	Symbol        string
	LastPrice     float64
	PercentChange float64
}

// Payload is the JSON body delivered inside the push event on the
// client. The service worker reads it and feeds it to
// self.registration.showNotification(). Type discriminates between the
// per-symbol alert and the daily watchlist digest; the SW routes
// notification clicks based on it.
type Payload struct {
	Type      string  `json:"type"` // "alert" or "watchlist"
	Symbol    string  `json:"symbol,omitempty"`
	Metric    string  `json:"metric,omitempty"`
	Op        string  `json:"op,omitempty"`
	Threshold float64 `json:"threshold,omitempty"`
	Observed  float64 `json:"observed,omitempty"`
	EventID   int     `json:"eventId,omitempty"`
	Title     string  `json:"title"`
	Body      string  `json:"body"`
}

// DigestDedupe gates the daily watchlist digest fan-out so each
// (user, trading-day) tuple receives at most one push, even when both
// the post-upload trigger (admin CSV) and the post-scrape trigger
// (15:30 UTC schedule) fire on the same day. Implemented by Redis:
// MarkDigestSent does an atomic SETNX with a ~30h TTL — returns true
// the first time and false on every subsequent call within the
// window. The service-worker tag also dedupes at the OS layer; this
// is the corresponding server-side gate that prevents the wasted
// webpush HTTP round trips.
type DigestDedupe interface {
	MarkDigestSent(ctx context.Context, userID int, day string) (newlyMarked bool, err error)
}

// Service wraps VAPID config + a subscription store.
type Service struct {
	vapidPublic  string
	vapidPrivate string
	subscriber   string // mailto: contact for the push service
	store        SubscriptionStore
	dedupe       DigestDedupe
	validator    *EndpointValidator
	log          *slog.Logger
}

// New creates a push service. subscriber should be a mailto: URL
// (e.g. "mailto:admin@yourdomain.com") per the VAPID spec. If the
// store is nil, SendToUser is a no-op.
func New(vapidPublic, vapidPrivate, subscriber string, store SubscriptionStore, log *slog.Logger) *Service {
	return &Service{
		vapidPublic:  vapidPublic,
		vapidPrivate: vapidPrivate,
		subscriber:   subscriber,
		store:        store,
		validator:    NewEndpointValidator(),
		log:          log,
	}
}

// SetEndpointValidator overrides the default push-service allowlist.
// Used to widen it from configuration when a browser we have not
// enumerated starts issuing endpoints from a new host.
func (s *Service) SetEndpointValidator(v *EndpointValidator) {
	if v != nil {
		s.validator = v
	}
}

// Validator exposes the configured allowlist so the HTTP layer can
// reject a bad endpoint at subscribe time — with a real status code —
// rather than silently dropping it here on a background goroutine.
func (s *Service) Validator() *EndpointValidator { return s.validator }

// SetDigestDedupe wires the per-(user, day) dedupe gate. Optional —
// when unset, the bulk SendWatchListDigest path runs without dedupe
// (matches pre-Redis-dedupe behaviour). The single-user
// SendDigestToUser path never dedupes; admin test runs are explicit.
func (s *Service) SetDigestDedupe(d DigestDedupe) { s.dedupe = d }

// SendAlertPush builds the notification payload from alert fields and
// dispatches it to every subscription the user has. Satisfies the
// alerts.WebPusher interface. Best-effort: individual failures are
// logged, not returned. Stale endpoints are deleted lazily.
func (s *Service) SendAlertPush(ctx context.Context, userID int, symbol, metric, op string, threshold, observed float64, eventID int) {
	payload := FormatAlertPayload(symbol, metric, op, threshold, observed, eventID)
	s.sendToUser(ctx, userID, payload)
}

// SendDigestToUser is a single-user variant of SendWatchListDigest used by
// the admin test endpoint at /v1/admin/push/test-digest. The caller passes
// the watchlist directly so the test path doesn't need to JOIN against
// push_subscriptions — if the user has no subscription, sendToUser is a
// no-op and the admin sees an empty result. Same payload format as the
// bulk fan-out so what shows up on the test device exactly mirrors what
// users will see at market close.
func (s *Service) SendDigestToUser(ctx context.Context, userID int, watchlist []string, snapshot map[string]SymbolSnap) {
	if s == nil {
		return
	}
	payload, ok := buildDigestPayload(watchlist, snapshot)
	if !ok {
		return
	}
	s.sendToUser(ctx, userID, payload)
}

// SendWatchListDigest fans out a "market close digest" notification to every
// user that has at least one push subscription and at least one watchlist
// symbol. For each user the body lists their top-3 watchlist symbols by
// absolute percent change, with "+N more in your watchlist" when they have
// more. Symbols missing from the snapshot (delisted, scraper miss) are
// silently skipped per-user; users with zero matches don't get a push.
//
// Best-effort: individual send failures are logged, not returned. Designed
// to be called once after the daily scrape; the service worker dedupes by
// tag so a duplicate fan-out within the same day silently replaces the
// previous notification.
func (s *Service) SendWatchListDigest(ctx context.Context, snapshot map[string]SymbolSnap) {
	if s == nil || s.store == nil {
		return
	}
	if len(snapshot) == 0 {
		return
	}
	rows, err := s.store.ListWatchListsForPushSubscribers(ctx)
	if err != nil {
		s.log.Warn("digest: list watchlists failed", "error", err)
		return
	}
	if len(rows) == 0 {
		return
	}
	day := time.Now().UTC().Format("2006-01-02")
	for _, row := range rows {
		// Honour overall deadline so a clearly-cancelled parent ctx
		// (Shutdown, hard 90s upload-digest cap) ends the loop fast
		// rather than spinning through every remaining user with
		// already-failing sends.
		if err := ctx.Err(); err != nil {
			s.log.Warn("digest: parent ctx cancelled mid fan-out",
				"err", err, "remaining_users", len(rows)-row.UserID)
			return
		}
		payload, ok := buildDigestPayload(row.Symbols, snapshot)
		if !ok {
			continue
		}
		// Server-side per-(user, day) dedupe. When upload-triggered
		// digest + scheduled post-scrape digest both fire on the same
		// trading day (admin uploads after the scrape window, e.g.),
		// the second pass would otherwise burn webpush HTTP round
		// trips even though the SW tag collapses them at the OS
		// layer. SetNX returns false when the key already exists, so
		// only the first dispatcher per user per day actually pushes.
		if s.dedupe != nil {
			marked, dErr := s.dedupe.MarkDigestSent(ctx, row.UserID, day)
			if dErr != nil {
				// Soft-fail: a Redis blip shouldn't suppress the
				// digest. Worst case we double-fire one user — same
				// as pre-dedupe behaviour.
				s.log.Warn("digest: dedupe check failed",
					"user_id", row.UserID, "error", dErr)
			} else if !marked {
				continue
			}
		}
		// Per-user budget so a single stalled user (or a provider
		// throttling that user's endpoint) can't starve the rest of
		// the fan-out. 10s is plenty for one user's subscription set;
		// legitimate webpush calls return well under a second.
		userCtx, cancel := context.WithTimeout(ctx, perUserPushTimeout)
		s.sendToUser(userCtx, row.UserID, payload)
		cancel()
	}
}

// buildDigestPayload selects the top-3 symbols (by |Δ%|) from the user's
// watchlist that the snapshot has prices for, and formats the notification
// title + body. The title is direction-aware (computed from the full match
// set, not just the top 3) so the user sees their watchlist's overall mood
// at a glance — not just whatever 3 symbols moved most. Returns ok=false
// if no matching symbols, so the caller can skip users whose watchlist
// has zero overlap with the day's scrape.
func buildDigestPayload(watchlist []string, snapshot map[string]SymbolSnap) (Payload, bool) {
	var snaps []SymbolSnap
	for _, sym := range watchlist {
		if snap, found := snapshot[sym]; found {
			snaps = append(snaps, snap)
		}
	}
	if len(snaps) == 0 {
		return Payload{}, false
	}

	title := digestTitle(snaps)

	sort.SliceStable(snaps, func(i, j int) bool {
		return math.Abs(snaps[i].PercentChange) > math.Abs(snaps[j].PercentChange)
	})

	// Soft cap so notification bodies don't get OS-truncated. Most users
	// have well under this many symbols on a watchlist; for the rest we
	// keep the top movers and append a "+N more" overflow line.
	const maxLines = 10
	keep := snaps
	more := 0
	if len(snaps) > maxLines {
		keep = snaps[:maxLines]
		more = len(snaps) - maxLines
	}

	// Body lines: SYMBOL<pad> ARROW PCT%<pad> ¢PRICE — columns aligned
	// by rune count using U+2007 FIGURE SPACE for padding. Figure space
	// is the Unicode character specifically intended for tabular column
	// alignment; unlike ASCII space and NBSP, conformant renderers
	// preserve it as content. Width is the same as a tabular digit
	// (close enough to a regular space in most fonts), so the columns
	// look like padded text rather than dotted gaps.
	//
	// Flat closes use → instead of an awkward ↑0.00%.
	const figSpace = " "
	type row struct{ sym, pct, price string }
	rows := make([]row, 0, len(keep))
	maxSym, maxPct := 0, 0
	for _, sn := range keep {
		var arrow string
		switch {
		case sn.PercentChange > 0:
			arrow = "↑"
		case sn.PercentChange < 0:
			arrow = "↓"
		default:
			arrow = "→"
		}
		r := row{
			sym:   sn.Symbol,
			pct:   fmt.Sprintf("%s%.2f%%", arrow, math.Abs(sn.PercentChange)),
			price: "¢" + formatPrice(sn.LastPrice),
		}
		rows = append(rows, r)
		if n := utf8.RuneCountInString(r.sym); n > maxSym {
			maxSym = n
		}
		if n := utf8.RuneCountInString(r.pct); n > maxPct {
			maxPct = n
		}
	}
	lines := make([]string, 0, len(rows)+1)
	for _, r := range rows {
		symPad := strings.Repeat(figSpace, maxSym-utf8.RuneCountInString(r.sym))
		pctPad := strings.Repeat(figSpace, maxPct-utf8.RuneCountInString(r.pct))
		lines = append(lines, fmt.Sprintf("%s%s %s%s %s", r.sym, symPad, r.pct, pctPad, r.price))
	}
	if more > 0 {
		lines = append(lines, fmt.Sprintf("+%d more in your watchlist", more))
	}
	return Payload{
		Type:  "watchlist",
		Title: title,
		Body:  strings.Join(lines, "\n"),
	}, true
}

// digestTitle returns a one-line summary of the user's watchlist mood
// based on direction tallies across every matching symbol. Includes
// counts so the at-a-glance read on the lock screen carries strictly
// more information than just "Mixed close" — `2 up · 2 down` tells the
// user immediately whether their portfolio was net positive without
// having to open the notification.
func digestTitle(snaps []SymbolSnap) string {
	ups, downs, flats := 0, 0, 0
	for _, sn := range snaps {
		switch {
		case sn.PercentChange > 0:
			ups++
		case sn.PercentChange < 0:
			downs++
		default:
			flats++
		}
	}
	total := ups + downs + flats
	switch {
	case downs == 0 && flats == 0:
		return fmt.Sprintf("Watchlist · all %d up", total)
	case ups == 0 && flats == 0:
		return fmt.Sprintf("Watchlist · all %d down", total)
	case ups == 0 && downs == 0:
		return fmt.Sprintf("Watchlist · all %d flat", total)
	default:
		return fmt.Sprintf("Watchlist · %d up · %d down", ups, downs)
	}
}

func formatPrice(p float64) string {
	if p >= 100 {
		return fmt.Sprintf("%.0f", p)
	}
	return fmt.Sprintf("%.2f", p)
}

func (s *Service) sendToUser(ctx context.Context, userID int, payload Payload) {
	if s == nil || s.store == nil {
		return
	}
	subs, err := s.store.ListPushSubscriptions(ctx, userID)
	if err != nil {
		s.log.Warn("push: list subscriptions failed", "user_id", userID, "error", err)
		return
	}
	if len(subs) == 0 {
		return
	}

	data, err := json.Marshal(payload)
	if err != nil {
		s.log.Warn("push: marshal payload failed", "error", err)
		return
	}

	for _, sub := range subs {
		// Re-check on the way out. Subscribe-time validation is the
		// primary gate, but rows predating it are already in the table
		// and this is the last point before an outbound request is
		// actually made — the place where a bad endpoint stops being a
		// database row and becomes a request into whatever it names.
		if s.validator != nil {
			if err := s.validator.ValidateEndpoint(sub.Endpoint); err != nil {
				s.log.Warn("push: refusing to send to disallowed endpoint",
					"user_id", userID, "endpoint", truncate(sub.Endpoint, 60), "error", err)
				continue
			}
		}
		// SendNotificationWithContext binds the per-user 10s budget
		// (set by SendWatchListDigest) to the actual webpush HTTP
		// call — which is the dominant latency source. The
		// non-context SendNotification uses http.DefaultClient
		// internally and would silently ignore our timeout, leaving
		// one stalled provider able to eat the entire 90s upload-
		// digest budget across many users.
		resp, err := webpush.SendNotificationWithContext(ctx, data, &webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys: webpush.Keys{
				P256dh: sub.P256dh,
				Auth:   sub.AuthSecret,
			},
		}, &webpush.Options{
			Subscriber:      s.subscriber,
			VAPIDPublicKey:  s.vapidPublic,
			VAPIDPrivateKey: s.vapidPrivate,
			TTL:             60 * 60, // 1 hour
		})
		if err != nil {
			s.log.Warn("push: send failed", "endpoint", truncate(sub.Endpoint, 60), "error", err)
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
			// Subscription expired or was revoked by the user.
			s.log.Info("push: removing stale subscription", "endpoint", truncate(sub.Endpoint, 60))
			_ = s.store.DeletePushSubscriptionByEndpoint(ctx, sub.Endpoint)
		} else if resp.StatusCode >= 400 {
			s.log.Warn("push: provider rejected", "status", resp.StatusCode, "endpoint", truncate(sub.Endpoint, 60))
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// FormatAlertPayload builds the notification body from an alert event's
// data. Centralised here so both the evaluator and any future manual
// "test push" endpoint produce consistent copy.
func FormatAlertPayload(symbol, metric, op string, threshold, observed float64, eventID int) Payload {
	fmtVal := func(m string, v float64) string {
		switch m {
		case "price":
			return fmt.Sprintf("¢%.2f", v)
		case "pct_change":
			return fmt.Sprintf("%.2f%%", v)
		case "rsi":
			return fmt.Sprintf("%.1f", v)
		default:
			return fmt.Sprintf("%.4f", v)
		}
	}
	return Payload{
		Type:      "alert",
		Symbol:    symbol,
		Metric:    metric,
		Op:        op,
		Threshold: threshold,
		Observed:  observed,
		EventID:   eventID,
		Title:     fmt.Sprintf("%s Alert", symbol),
		Body:      fmt.Sprintf("%s %s %s (now %s)", metricLabel(metric), op, fmtVal(metric, threshold), fmtVal(metric, observed)),
	}
}

func metricLabel(m string) string {
	switch m {
	case "price":
		return "Price"
	case "pct_change":
		return "% Change"
	case "rsi":
		return "RSI(14)"
	default:
		return m
	}
}
