package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/teckdroids/ges-data-engine/internal/alerts"
	"github.com/teckdroids/ges-data-engine/internal/audit"
	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// alertRunner is the narrow interface Server.alertEvaluator exposes — just
// enough surface for HandleUpload to kick a post-upload re-evaluation.
// Declaring it here (rather than importing the concrete *alerts.Evaluator)
// keeps the server package decoupled from alerts internals; main.go wires
// the concrete implementation via SetAlertEvaluator.
type alertRunner interface {
	Run(ctx context.Context, snapshot []alerts.Snapshot) (int, error)
}

// SetAlertEvaluator wires the (optional) post-upload alert runner. When
// nil the upload handler simply skips the evaluation step.
func (s *Server) SetAlertEvaluator(r alertRunner) { s.alertEvaluator = r }

// evaluateAlerts pulls the latest QuestDB market snapshot and runs the
// alert evaluator. Invoked from HandleUpload via goBackground so a stalled
// evaluator can't hold the HTTP response. Bounded by a 90s timeout on top
// of the parent bgCtx; the evaluator itself re-caps individual email sends.
func (s *Server) evaluateAlerts(parent context.Context) {
	if s.alertEvaluator == nil || s.qdbRepo == nil {
		return
	}
	log := LoggerFromCtx(parent).With("component", "alerts-upload")
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()

	snapshot, err := s.qdbRepo.GetMarketSummary(ctx)
	if err != nil {
		log.Warn("alerts: snapshot load failed", "error", err)
		return
	}
	out := make([]alerts.Snapshot, 0, len(snapshot))
	for _, item := range snapshot {
		out = append(out, alerts.Snapshot{
			Symbol:        item.Symbol,
			LastPrice:     item.LastPrice,
			PercentChange: item.PercentChange,
		})
	}
	fired, err := s.alertEvaluator.Run(ctx, out)
	if err != nil {
		log.Warn("alerts: evaluator error", "error", err, "fired", fired)
		return
	}
	if fired > 0 {
		log.Info("alerts fired (post-upload)", "count", fired)
	}
}

// ─── alerts.RuleStore adapter ──────────────────────────────────────────────
//
// The alerts package declares its own Rule / Event domain types + a
// narrow RuleStore interface so it can stay free of an `internal/repository`
// import (which would cycle back through internal/analysis → internal/repository).
// alertRuleStore is the thin adapter that sits between the evaluator and
// the real pgx-backed repo: it delegates queries to PostgresRepo and
// converts repository.AlertRule ↔ alerts.Rule at the boundary.
//
// NewAlertRuleStore is invoked once during server construction and the
// returned *alertRuleStore is handed to alerts.NewEvaluator. The conversion
// is zero-allocation for scalar fields (both types are structs of primitives);
// only the time-pointer + string slices move.

type alertRuleStore struct {
	pg *repository.PostgresRepo
}

// NewAlertRuleStore returns an adapter satisfying alerts.RuleStore.
func NewAlertRuleStore(pg *repository.PostgresRepo) alerts.RuleStore {
	return &alertRuleStore{pg: pg}
}

func (a *alertRuleStore) ListEnabledAlertRules(ctx context.Context) ([]alerts.Rule, error) {
	rows, err := a.pg.ListEnabledAlertRules(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]alerts.Rule, 0, len(rows))
	for _, r := range rows {
		out = append(out, toAlertsRule(r))
	}
	return out, nil
}

func (a *alertRuleStore) MarkAlertFired(ctx context.Context, ruleID int, observed float64) error {
	return a.pg.MarkAlertFired(ctx, ruleID, observed)
}

func (a *alertRuleStore) CreateAlertEvent(ctx context.Context, ev alerts.Event) (int, error) {
	return a.pg.CreateAlertEvent(ctx, repository.AlertEvent{
		RuleID:        ev.RuleID,
		UserID:        ev.UserID,
		Symbol:        ev.Symbol,
		Metric:        ev.Metric,
		Op:            ev.Op,
		Threshold:     ev.Threshold,
		ObservedValue: ev.ObservedValue,
		FiredAt:       ev.FiredAt,
	})
}

func (a *alertRuleStore) GetUserEmail(ctx context.Context, userID int) (string, error) {
	return a.pg.GetUserEmail(ctx, userID)
}

func toAlertsRule(r repository.AlertRule) alerts.Rule {
	return alerts.Rule{
		ID:          r.ID,
		UserID:      r.UserID,
		Symbol:      r.Symbol,
		Metric:      r.Metric,
		Op:          r.Op,
		Threshold:   r.Threshold,
		Enabled:     r.Enabled,
		LastFiredAt: r.LastFiredAt,
		FireCount:   r.FireCount,
		CreatedAt:   r.CreatedAt,
	}
}

// ─── HTTP handlers ─────────────────────────────────────────────────────────

// alertCreateReq is the body of POST /v1/me/alerts. Field validation is
// centralised in validate() below — the DB CHECK constraints catch any
// slippage, but validating at the API boundary gives callers a clean 400
// with a descriptive message instead of a cryptic pgx error.
type alertCreateReq struct {
	Symbol    string  `json:"symbol"`
	Metric    string  `json:"metric"`
	Op        string  `json:"op"`
	Threshold float64 `json:"threshold"`
}

func (req *alertCreateReq) validate() (string, bool) {
	req.Symbol = strings.ToUpper(strings.TrimSpace(req.Symbol))
	req.Metric = strings.TrimSpace(req.Metric)
	req.Op = strings.TrimSpace(req.Op)
	if req.Symbol == "" {
		return "symbol required", false
	}
	if !validateSymbol(req.Symbol) {
		return "invalid symbol", false
	}
	switch req.Metric {
	case alerts.MetricPrice, alerts.MetricRSI, alerts.MetricPctChange:
	default:
		return "metric must be one of price, rsi, pct_change", false
	}
	switch req.Op {
	case alerts.OpGT, alerts.OpLT, alerts.OpGTE, alerts.OpLTE:
	default:
		return "op must be one of >, <, >=, <=", false
	}
	// Sanity bounds — prevent NaN / ±Inf from landing in the DB.
	if req.Threshold != req.Threshold { // NaN check
		return "threshold is NaN", false
	}
	if req.Metric == alerts.MetricRSI {
		if req.Threshold < 0 || req.Threshold > 100 {
			return "rsi threshold must be between 0 and 100", false
		}
	}
	if req.Metric == alerts.MetricPrice && req.Threshold < 0 {
		return "price threshold cannot be negative", false
	}
	return "", true
}

// HandleListAlertRules returns the caller's watchlist alert rules
// (including disabled ones so the UI can offer a "re-arm" action).
func (s *Server) HandleListAlertRules(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	rows, err := s.pgRepo.ListAlertRulesByUser(r.Context(), user.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load alert rules")
		return
	}
	respondJSON(w, rows)
}

// HandleCreateAlertRule provisions a new rule for the caller. Rejects with
// 403 if the user has no verified email on file — Phase 1 requires email
// to gate the outgoing-notification path, matching the product spec.
func (s *Server) HandleCreateAlertRule(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	// Email gate — only users with a VERIFIED email can author alerts.
	// The frontend routes users without one into the "connect email"
	// panel before they hit this endpoint, but the 403 below is the
	// source of truth. `emailVerified` is flipped TRUE either by the
	// OAuth callback (provider-verified) or by the manual-verify token
	// click (/auth/verify-email).
	emailAddr, verified, err := s.pgRepo.GetUserEmailInfo(r.Context(), user.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to check email")
		return
	}
	if emailAddr == "" || !verified {
		respondError(w, http.StatusForbidden, "alerts require a verified email on your account")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 2<<10) // 2 KiB is plenty
	defer r.Body.Close()
	var req alertCreateReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if msg, ok := req.validate(); !ok {
		respondError(w, http.StatusBadRequest, msg)
		return
	}

	// Per-user cap to protect the evaluator's hot path.
	count, err := s.pgRepo.CountAlertRulesByUser(r.Context(), user.ID)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to count rules")
		return
	}
	if count >= alerts.MaxRulesPerUser {
		respondError(w, http.StatusBadRequest, "alert rule limit reached")
		return
	}

	id, err := s.pgRepo.CreateAlertRule(r.Context(), repository.AlertRule{
		UserID:    user.ID,
		Symbol:    req.Symbol,
		Metric:    req.Metric,
		Op:        req.Op,
		Threshold: req.Threshold,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create rule")
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), audit.ActionAlertCreate, "alert_rule", strconv.Itoa(id), map[string]interface{}{
			"symbol":    req.Symbol,
			"metric":    req.Metric,
			"op":        req.Op,
			"threshold": req.Threshold,
		})
	}

	w.WriteHeader(http.StatusCreated)
	respondJSON(w, map[string]interface{}{"id": id})
}

// alertToggleReq toggles a rule's enabled flag. Used both to re-arm a
// fired rule and to pause an annoying one without losing its config.
type alertToggleReq struct {
	Enabled bool `json:"enabled"`
}

func (s *Server) HandleUpdateAlertRule(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	ruleID, err := strconv.Atoi(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid rule id")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	defer r.Body.Close()
	var req alertToggleReq
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	if err := s.pgRepo.UpdateAlertRuleEnabled(r.Context(), user.ID, ruleID, req.Enabled); err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), audit.ActionAlertToggle, "alert_rule", strconv.Itoa(ruleID),
			map[string]interface{}{"enabled": req.Enabled})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) HandleDeleteAlertRule(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	ruleID, err := strconv.Atoi(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid rule id")
		return
	}
	if err := s.pgRepo.DeleteAlertRule(r.Context(), user.ID, ruleID); err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), audit.ActionAlertDelete, "alert_rule", strconv.Itoa(ruleID), nil)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Alert events (the in-app drawer) ──────────────────────────────────────

// HandleListAlertEvents serves the drawer feed. ?unread=1 returns only
// unread items (powered by the partial index in migration V8).
func (s *Server) HandleListAlertEvents(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	unreadOnly := r.URL.Query().Get("unread") == "1"

	// One round-trip for both the events page and the unread badge
	// count — see ListAlertEventsWithUnread. Bell-badge poll is on the
	// hot path (drawer-open + every WebSocket alert push), so halving
	// DB load there has been worth the slightly chunkier query.
	events, unread, err := s.pgRepo.ListAlertEventsWithUnread(r.Context(), user.ID, limit, unreadOnly)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load events")
		return
	}

	respondJSON(w, map[string]interface{}{
		"events":      events,
		"unreadCount": unread,
	})
}

// HandleMarkAlertEventRead clears a single drawer badge.
func (s *Server) HandleMarkAlertEventRead(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	eventID, err := strconv.Atoi(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid event id")
		return
	}
	if err := s.pgRepo.MarkAlertEventRead(r.Context(), user.ID, eventID); err != nil {
		// Treat "already read" / "not found" as success — idempotent.
		respondJSON(w, map[string]string{"status": "ok"})
		return
	}
	respondJSON(w, map[string]string{"status": "ok"})
}

// ─── Admin-scope alert handlers ─────────────────────────────────────────────
//
// These sit at /v1/admin/alert-* and power the admin portal's Alerts tab.
// Gated by AdminMiddleware at the router level — handlers themselves assume
// the caller is already admin and don't re-check.

// HandleAdminListAlertRules returns every rule in the system, joined with
// the owning username. Bounded result size (repo caps at 500 by default).
func (s *Server) HandleAdminListAlertRules(w http.ResponseWriter, r *http.Request) {
	limit := 500
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	rows, err := s.pgRepo.ListAllAlertRules(r.Context(), limit)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load alert rules")
		return
	}
	respondJSON(w, rows)
}

// HandleAdminListAlertEvents returns the most recent fires across all
// users. Feeds the "Recent Fires" table under the rules list.
func (s *Server) HandleAdminListAlertEvents(w http.ResponseWriter, r *http.Request) {
	limit := 200
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	events, err := s.pgRepo.ListAllAlertEvents(r.Context(), limit)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load alert events")
		return
	}
	respondJSON(w, events)
}

// HandleAdminAlertStats returns the numeric summary for the stat strip.
func (s *Server) HandleAdminAlertStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.pgRepo.GetAlertStats(r.Context())
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to load alert stats")
		return
	}
	respondJSON(w, stats)
}

// HandleAdminDeleteAlertRule force-deletes any user's rule. Audit-logged
// under alert.delete with an admin=true metadata flag so the user-scoped
// and admin-scoped deletes stay distinguishable in the trail.
func (s *Server) HandleAdminDeleteAlertRule(w http.ResponseWriter, r *http.Request) {
	ruleID, err := strconv.Atoi(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid rule id")
		return
	}
	if err := s.pgRepo.AdminDeleteAlertRule(r.Context(), ruleID); err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	if s.auditLog != nil {
		s.auditLog.Log(r.Context(), audit.ActionAlertDelete, "alert_rule", strconv.Itoa(ruleID),
			map[string]interface{}{"admin": true})
	}
	w.WriteHeader(http.StatusNoContent)
}

// HandleMarkAllAlertEventsRead clears the bell badge in one shot.
func (s *Server) HandleMarkAllAlertEventsRead(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if err := s.pgRepo.MarkAllAlertEventsRead(r.Context(), user.ID); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to mark read")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
