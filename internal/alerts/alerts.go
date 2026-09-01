// Package alerts evaluates user-authored watchlist alert rules against the
// most recent market snapshot and dispatches notifications (email + in-app
// push + audit log) for every rule whose predicate is satisfied.
//
// Lifecycle:
//  1. Rule authoring — via HTTP handlers in the server package.
//  2. Evaluation — Run is called from the post-scrape hook in main.go
//     after each ingestion. No ambient scheduler lives here; the caller
//     controls cadence.
//  3. Fire — Satisfied rules are disabled (enabled=false, last_fired_at
//     bumped) so they can't re-fire until the user manually re-arms.
//     This is the standard anti-spam pattern; the alternative
//     (cooldown + auto-rearm on recovery) is a Phase 2 feature.
package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/analysis"
	"github.com/teckdroids/ges-data-engine/internal/email"
)

// Audit action names the evaluator writes into the audit trail. Kept as
// package-local strings (mirrored in internal/audit/audit.go) so this
// package doesn't need a direct import on internal/audit — callers wire
// an AuditLogger interface, breaking the repository → alerts → audit →
// repository cycle.
const (
	auditActionFire = "alert.fire"
)

// AuditLogger is the narrow interface the evaluator needs. *audit.Logger
// satisfies it; callers inject it via NewEvaluator.
type AuditLogger interface {
	Log(ctx context.Context, action, targetType, targetID string, metadata map[string]interface{})
}

// BackgroundRunner schedules a fire-and-forget goroutine bound to a
// server-lifetime context that Shutdown can drain. The server injects its
// goBackground method via SetBackgroundRunner so email sends are awaited
// during shutdown instead of being orphaned mid-SMTP handshake.
type BackgroundRunner func(fn func(ctx context.Context))

// WebPusher sends a Web Push notification to all of a user's active
// subscriptions. The internal/push.Service satisfies this interface.
// Optional — evaluator tolerates nil and skips the web-push step.
type WebPusher interface {
	SendAlertPush(ctx context.Context, userID int, symbol, metric, op string, threshold, observed float64, eventID int)
}

// Metric vocabulary — must stay in lockstep with the CHECK constraint in
// migration V8. Adding a new metric requires a DB migration + evaluator
// branch below.
const (
	MetricPrice     = "price"
	MetricRSI       = "rsi"
	MetricPctChange = "pct_change"
)

// Op vocabulary — must stay in lockstep with the CHECK constraint.
const (
	OpGT  = ">"
	OpLT  = "<"
	OpGTE = ">="
	OpLTE = "<="
)

// MaxRulesPerUser caps rule count to protect the evaluator's per-ingestion
// workload (each RSI rule costs one QuestDB OHLC fetch). A 20-rule cap
// keeps a 1000-user deployment at ~20k rule evaluations per scrape — cheap
// because we batch symbol lookups.
const MaxRulesPerUser = 20

// RSIWindow is the period used for the Wilder RSI calculation on rsi-metric
// rules. 14 is the industry standard (and what the InsightService uses).
const RSIWindow = 14

// Rule mirrors the alert_rules row. Threshold is a DOUBLE PRECISION in
// Postgres — we don't use decimal here because every supported metric
// (price, percent, RSI index) is already a float domain.
type Rule struct {
	ID          int
	UserID      int
	Symbol      string
	Metric      string
	Op          string
	Threshold   float64
	Enabled     bool
	LastFiredAt *time.Time
	FireCount   int
	CreatedAt   time.Time
}

// Event mirrors the alert_events row. ObservedValue captures what the
// metric evaluated to at fire time so the drawer can show "RSI hit 28.3"
// without a second DB round-trip.
type Event struct {
	ID            int
	RuleID        int
	UserID        int
	Symbol        string
	Metric        string
	Op            string
	Threshold     float64
	ObservedValue float64
	FiredAt       time.Time
	ReadAt        *time.Time
}

// Snapshot is the minimal per-symbol market view the evaluator needs.
// Supplied by the caller rather than pulled from QuestDB here so the
// post-scrape hook can reuse the snapshot it already built for
// briefing/anomaly steps. Keeps the evaluator DB-agnostic for tests.
type Snapshot struct {
	Symbol        string
	LastPrice     float64
	PercentChange float64
}

// RuleStore is the narrow repository interface the evaluator depends on.
// PostgresRepo satisfies it in production; tests can implement in-memory.
type RuleStore interface {
	ListEnabledAlertRules(ctx context.Context) ([]Rule, error)
	MarkAlertFired(ctx context.Context, ruleID int, observedValue float64) error
	CreateAlertEvent(ctx context.Context, ev Event) (int, error)
	GetUserEmail(ctx context.Context, userID int) (email string, err error)
}

// HistoryStore supplies the N most recent daily close prices used for RSI
// evaluation. QuestDBRepo satisfies it in production.
type HistoryStore interface {
	GetRecentCloses(ctx context.Context, symbol string, limit int) ([]float64, error)
}

// Pusher delivers an in-app WebSocket message to every connected client
// authenticated as the given user. The server package's Hub satisfies it.
// Optional — evaluator tolerates a nil Pusher and skips the push step.
type Pusher interface {
	PushToUser(userID int, payload []byte) int // returns recipient count
}

// Evaluator is the glue between rule store, history store, email, and push.
type Evaluator struct {
	rules         RuleStore
	hist          HistoryStore
	mail          email.Sender
	push          Pusher
	webPush       WebPusher
	audit         AuditLogger
	log           *slog.Logger
	baseURL       string // used for deep-links inside outgoing emails
	runBackground BackgroundRunner
}

// SetBackgroundRunner wires a tracked goroutine launcher (typically
// server.goBackground) so email sends run under the server's WaitGroup
// and are awaited during Shutdown. Optional — falls back to an untracked
// goroutine if unset.
func (e *Evaluator) SetBackgroundRunner(r BackgroundRunner) {
	e.runBackground = r
}

// SetWebPusher wires the Web Push notification service. Optional.
func (e *Evaluator) SetWebPusher(wp WebPusher) {
	e.webPush = wp
}

// NewEvaluator wires up the evaluator. mail, push, and audit may be nil —
// each step is skipped gracefully when its dependency is absent.
func NewEvaluator(
	rules RuleStore,
	hist HistoryStore,
	mail email.Sender,
	push Pusher,
	auditLog AuditLogger,
	log *slog.Logger,
	baseURL string,
) *Evaluator {
	return &Evaluator{
		rules:   rules,
		hist:    hist,
		mail:    mail,
		push:    push,
		audit:   auditLog,
		log:     log,
		baseURL: baseURL,
	}
}

// Run evaluates every enabled rule against `snapshot` and fires any that
// match. Returns the number of rules that fired. Errors on individual
// rules are logged and skipped — one bad rule shouldn't sink a batch.
func (e *Evaluator) Run(ctx context.Context, snapshot []Snapshot) (int, error) {
	if e == nil || e.rules == nil {
		return 0, nil
	}

	rules, err := e.rules.ListEnabledAlertRules(ctx)
	if err != nil {
		return 0, fmt.Errorf("list rules: %w", err)
	}
	if len(rules) == 0 {
		return 0, nil
	}

	// Index snapshot by symbol for O(1) lookup inside the rule loop.
	byUpper := make(map[string]Snapshot, len(snapshot))
	for _, s := range snapshot {
		byUpper[strings.ToUpper(s.Symbol)] = s
	}

	fired := 0
	for _, rule := range rules {
		if err := ctx.Err(); err != nil {
			return fired, err
		}
		snap, ok := byUpper[strings.ToUpper(rule.Symbol)]
		if !ok {
			// Rule is for a symbol that wasn't traded today — skip,
			// don't error. Common on thin-trading days at GSE.
			continue
		}

		val, ok, err := e.resolveMetric(ctx, rule, snap)
		if err != nil {
			if e.log != nil {
				e.log.Warn("alert metric resolve failed",
					"rule_id", rule.ID, "symbol", rule.Symbol,
					"metric", rule.Metric, "error", err)
			}
			continue
		}
		if !ok {
			continue
		}
		if !predicate(rule.Op, val, rule.Threshold) {
			continue
		}

		if err := e.fire(ctx, rule, val); err != nil {
			if e.log != nil {
				e.log.Warn("alert fire failed",
					"rule_id", rule.ID, "symbol", rule.Symbol, "error", err)
			}
			continue
		}
		fired++
	}
	return fired, nil
}

// resolveMetric returns the current value of the rule's metric plus a
// "have enough data" flag. The flag is false when e.g. RSI can't be
// computed yet (fewer than RSIWindow+1 bars in history).
func (e *Evaluator) resolveMetric(ctx context.Context, rule Rule, snap Snapshot) (float64, bool, error) {
	switch rule.Metric {
	case MetricPrice:
		if snap.LastPrice <= 0 {
			return 0, false, nil
		}
		return snap.LastPrice, true, nil
	case MetricPctChange:
		return snap.PercentChange, true, nil
	case MetricRSI:
		if e.hist == nil {
			return 0, false, fmt.Errorf("history store not wired")
		}
		closes, err := e.hist.GetRecentCloses(ctx, rule.Symbol, RSIWindow+5)
		if err != nil {
			return 0, false, fmt.Errorf("fetch closes: %w", err)
		}
		if len(closes) < RSIWindow+1 {
			return 0, false, nil
		}
		rsi := analysis.WilderRSI(closes, RSIWindow)
		return rsi, true, nil
	default:
		return 0, false, fmt.Errorf("unknown metric %q", rule.Metric)
	}
}

// predicate returns true if `op(value, threshold)` holds. The supported
// op set is enforced by the DB CHECK constraint so an unknown op here
// indicates schema drift, not user input.
func predicate(op string, value, threshold float64) bool {
	switch op {
	case OpGT:
		return value > threshold
	case OpLT:
		return value < threshold
	case OpGTE:
		return value >= threshold
	case OpLTE:
		return value <= threshold
	}
	return false
}

// fire handles a single satisfied rule: mark fired, write event, push
// in-app, send email, audit log. Each side-effect is best-effort past the
// mark-fired + event-write (those are the sources of truth).
func (e *Evaluator) fire(ctx context.Context, rule Rule, observed float64) error {
	// 1) Mark the rule fired + disabled. Doing this BEFORE the event
	//    write prevents a crash between steps from re-firing the rule
	//    on the next ingestion.
	if err := e.rules.MarkAlertFired(ctx, rule.ID, observed); err != nil {
		return fmt.Errorf("mark fired: %w", err)
	}

	// 2) Persist event so the in-app drawer has something to render
	//    regardless of whether the user was connected when it fired.
	ev := Event{
		RuleID:        rule.ID,
		UserID:        rule.UserID,
		Symbol:        rule.Symbol,
		Metric:        rule.Metric,
		Op:            rule.Op,
		Threshold:     rule.Threshold,
		ObservedValue: observed,
		FiredAt:       time.Now().UTC(),
	}
	eventID, err := e.rules.CreateAlertEvent(ctx, ev)
	if err != nil {
		// Don't unwind the mark-fired above — a missing event row is
		// recoverable (the user just doesn't see a badge), a re-fired
		// rule is not.
		return fmt.Errorf("create event: %w", err)
	}
	ev.ID = eventID

	// 3) In-app push. Evicts silently if the user isn't connected;
	//    the persisted event still appears in the drawer.
	if e.push != nil {
		payload := buildPushPayload(ev)
		e.push.PushToUser(rule.UserID, payload)
	}

	// 4) Email — best-effort, short timeout so a stalled relay doesn't
	//    block the whole post-scrape batch. When a BackgroundRunner is
	//    wired, the send is awaited by server Shutdown so in-flight SMTP
	//    isn't orphaned at process exit.
	if e.mail != nil {
		r, obs, evID := rule, observed, eventID
		send := func(bgCtx context.Context) {
			mctx, cancel := context.WithTimeout(bgCtx, 15*time.Second)
			defer cancel()
			if err := e.sendEmail(mctx, r, obs); err != nil && e.log != nil {
				e.log.Warn("alert email send failed",
					"rule_id", r.ID, "event_id", evID, "error", err)
			}
		}
		if e.runBackground != nil {
			e.runBackground(send)
		} else {
			go send(context.Background())
		}
	}

	// 4.5) Web Push notification — delivers a browser push to every
	//       device the user has subscribed. Best-effort; stale
	//       endpoints are pruned lazily by the push service.
	if e.webPush != nil {
		r, obs, evID := rule, observed, eventID
		sendPush := func(bgCtx context.Context) {
			pushCtx, cancel := context.WithTimeout(bgCtx, 15*time.Second)
			defer cancel()
			e.webPush.SendAlertPush(pushCtx, r.UserID, r.Symbol, r.Metric, r.Op, r.Threshold, obs, evID)
		}
		if e.runBackground != nil {
			e.runBackground(sendPush)
		} else {
			go sendPush(context.Background())
		}
	}

	// 5) Audit trail.
	if e.audit != nil {
		e.audit.Log(ctx, auditActionFire, "alert_rule", fmt.Sprintf("%d", rule.ID),
			map[string]interface{}{
				"symbol":    rule.Symbol,
				"metric":    rule.Metric,
				"op":        rule.Op,
				"threshold": rule.Threshold,
				"observed":  observed,
				"user_id":   rule.UserID,
			})
	}
	return nil
}

// sendEmail resolves the recipient address + formats the body. Returns
// nil quietly when the user has no email on file (alerts still fired —
// they just got the in-app push instead).
func (e *Evaluator) sendEmail(ctx context.Context, rule Rule, observed float64) error {
	addr, err := e.rules.GetUserEmail(ctx, rule.UserID)
	if err != nil {
		return fmt.Errorf("lookup email: %w", err)
	}
	if addr == "" {
		return nil // user has no email — in-app only is fine
	}
	subject, html, plain := renderEmail(rule, observed, e.baseURL)
	return e.mail.Send(ctx, addr, subject, html, plain)
}

// renderEmail produces the subject + html + plaintext for a fired alert.
// Kept inline (no template files) because there's exactly one email type
// in Phase 1 and the body is ~15 lines of HTML — a template engine would
// be strictly more moving parts.
func renderEmail(rule Rule, observed float64, baseURL string) (subject, html, plain string) {
	direction := "crossed"
	switch rule.Op {
	case OpGT, OpGTE:
		direction = "risen above"
	case OpLT, OpLTE:
		direction = "fallen below"
	}

	metricLabel := rule.Metric
	switch rule.Metric {
	case MetricPrice:
		metricLabel = "price"
	case MetricRSI:
		metricLabel = "RSI(14)"
	case MetricPctChange:
		metricLabel = "% change"
	}

	thresholdStr := formatValue(rule.Metric, rule.Threshold)
	observedStr := formatValue(rule.Metric, observed)

	subject = fmt.Sprintf("[GSE Alert] %s %s has %s %s",
		rule.Symbol, metricLabel, direction, thresholdStr)

	deepLink := ""
	if baseURL != "" {
		deepLink = fmt.Sprintf("%s/terminal?symbol=%s", strings.TrimRight(baseURL, "/"), rule.Symbol)
	}

	html = fmt.Sprintf(`<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#0b0a08;color:#f4ecd8;padding:24px;margin:0;">
<div style="max-width:520px;margin:0 auto;background:#100e0a;border:1px solid rgba(244,236,216,0.22);padding:28px;">
<div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.24em;color:#ffb12b;margin-bottom:16px;">GSE TERMINAL · ALERT FIRED</div>
<h1 style="font-family:Georgia,serif;font-size:28px;margin:0 0 4px 0;color:#f4ecd8;">%s</h1>
<p style="color:rgba(244,236,216,0.7);margin:0 0 20px 0;font-size:13px;">The <strong>%s</strong> of %s has %s your threshold.</p>
<table style="width:100%%;border-collapse:collapse;font-family:'Courier New',monospace;font-size:12px;margin-bottom:20px;">
<tr><td style="padding:8px 0;color:rgba(244,236,216,0.5);border-bottom:1px solid rgba(244,236,216,0.1);">METRIC</td><td style="padding:8px 0;text-align:right;border-bottom:1px solid rgba(244,236,216,0.1);">%s</td></tr>
<tr><td style="padding:8px 0;color:rgba(244,236,216,0.5);border-bottom:1px solid rgba(244,236,216,0.1);">CONDITION</td><td style="padding:8px 0;text-align:right;border-bottom:1px solid rgba(244,236,216,0.1);">%s %s %s</td></tr>
<tr><td style="padding:8px 0;color:rgba(244,236,216,0.5);border-bottom:1px solid rgba(244,236,216,0.1);">CURRENT VALUE</td><td style="padding:8px 0;text-align:right;color:#ffb12b;font-weight:bold;border-bottom:1px solid rgba(244,236,216,0.1);">%s</td></tr>
</table>
%s
<p style="color:rgba(244,236,216,0.4);font-size:11px;margin-top:24px;">This alert has been disarmed. Re-enable it from your watchlist if you'd like to be notified again.</p>
</div></body></html>`,
		rule.Symbol, metricLabel, rule.Symbol, direction,
		metricLabel, metricLabel, rule.Op, thresholdStr, observedStr,
		buttonHTML(deepLink, rule.Symbol),
	)

	plain = fmt.Sprintf(`GSE TERMINAL — ALERT FIRED

%s — %s has %s your threshold.

Metric:    %s
Condition: %s %s %s
Observed:  %s

%s

This alert has been disarmed. Re-enable it from your watchlist to keep watching.`,
		rule.Symbol, metricLabel, direction,
		metricLabel, metricLabel, rule.Op, thresholdStr, observedStr,
		deepLink,
	)
	return subject, html, plain
}

func buttonHTML(link, symbol string) string {
	if link == "" {
		return ""
	}
	return fmt.Sprintf(`<a href="%s" style="display:inline-block;background:#ffb12b;color:#0b0a08;padding:10px 20px;text-decoration:none;font-family:'Courier New',monospace;font-size:11px;font-weight:bold;letter-spacing:0.2em;text-transform:uppercase;">View %s →</a>`, link, symbol)
}

// formatValue renders a metric value in its canonical display form:
//
//	price       → "¢12.34"
//	rsi         → "28.3"
//	pct_change  → "-3.42%"
func formatValue(metric string, v float64) string {
	switch metric {
	case MetricPrice:
		return fmt.Sprintf("¢%.2f", v)
	case MetricPctChange:
		return fmt.Sprintf("%.2f%%", v)
	case MetricRSI:
		return fmt.Sprintf("%.1f", v)
	}
	return fmt.Sprintf("%.4f", v)
}

// pushPayload is the JSON shape clients see. `type: "alert"` is the
// discriminator the websocket handler in the frontend switches on.
type pushPayload struct {
	Type    string  `json:"type"`
	EventID int     `json:"eventId"`
	RuleID  int     `json:"ruleId"`
	Symbol  string  `json:"symbol"`
	Metric  string  `json:"metric"`
	Op      string  `json:"op"`
	Thresh  float64 `json:"threshold"`
	Value   float64 `json:"value"`
	When    string  `json:"firedAt"` // RFC3339
}

func buildPushPayload(ev Event) []byte {
	p := pushPayload{
		Type:    "alert",
		EventID: ev.ID,
		RuleID:  ev.RuleID,
		Symbol:  ev.Symbol,
		Metric:  ev.Metric,
		Op:      ev.Op,
		Thresh:  ev.Threshold,
		Value:   ev.ObservedValue,
		When:    ev.FiredAt.UTC().Format(time.RFC3339),
	}
	return mustJSON(p)
}

// mustJSON marshals a pushPayload that we know is round-trippable.
// Returns a sentinel frame on the impossible marshal error so the WS
// handler never sees a zero-byte payload.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"type":"alert","error":"marshal failed"}`)
	}
	return b
}
