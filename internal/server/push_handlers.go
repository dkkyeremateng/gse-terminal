package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/push"
)

// digestRunner is the narrow interface Server.digestRunner exposes — just
// enough surface for HandleAdminTestDigest to fire either a self-only
// test push or a full fan-out. Declared here (not imported as the concrete
// *push.Service) so the server package isn't tightly coupled to push
// internals; main.go wires the concrete implementation via SetDigestRunner.
type digestRunner interface {
	SendWatchListDigest(ctx context.Context, snapshot map[string]push.SymbolSnap)
	SendDigestToUser(ctx context.Context, userID int, watchlist []string, snapshot map[string]push.SymbolSnap)
}

// SetDigestRunner wires the (optional) watchlist digest dispatcher. When
// nil the test endpoint returns 503; the live post-scrape dispatch path
// in cmd/server/main.go is unaffected.
func (s *Server) SetDigestRunner(r digestRunner) { s.digestRunner = r }

// dispatchUploadDigest pulls the latest QuestDB market snapshot and fires
// a watchlist digest fan-out — the same notification users get after the
// daily 15:30 UTC scrape, but triggered when an admin CSV upload changes
// the underlying data outside the scheduled run. Invoked from HandleUpload
// via goBackground so a slow Web Push provider can't hold the upload
// response. Bounded by a 90s timeout on top of the parent bgCtx, mirroring
// the evaluateAlerts pattern. The service worker dedupes by per-day tag,
// so a digest fired by upload + a later scrape on the same day silently
// replaces rather than duplicates.
func (s *Server) dispatchUploadDigest(parent context.Context) {
	if s.digestRunner == nil || s.qdbRepo == nil {
		return
	}
	log := LoggerFromCtx(parent).With("component", "digest-upload")
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()

	rows, err := s.qdbRepo.GetMarketSummary(ctx)
	if err != nil {
		log.Warn("digest: snapshot load failed", "error", err)
		return
	}
	snapshot := make(map[string]push.SymbolSnap, len(rows))
	for _, row := range rows {
		if row.Symbol == "" {
			continue
		}
		snapshot[row.Symbol] = push.SymbolSnap{
			Symbol:        row.Symbol,
			LastPrice:     row.LastPrice,
			PercentChange: row.PercentChange,
		}
	}
	if len(snapshot) == 0 {
		return
	}
	s.digestRunner.SendWatchListDigest(ctx, snapshot)
	log.Info("digest dispatched (post-upload)", "symbols", len(snapshot))
}

// HandleGetDigestPreference returns the authenticated user's current
// daily-watchlist-digest opt-in flag. Used by the settings UI to
// reflect the toggle's current state.
//
// GET /v1/me/digest-preference
func (s *Server) HandleGetDigestPreference(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	enabled, err := s.pgRepo.GetDigestEnabled(r.Context(), user.ID)
	if err != nil {
		LoggerFromCtx(r.Context()).Error("get digest preference failed", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to read preference")
		return
	}
	respondJSON(w, map[string]bool{"digestEnabled": enabled})
}

// HandleSetDigestPreference flips the per-user daily watchlist digest
// opt-in. Disabling silences only the daily fan-out; alert-rule
// notifications remain on whatever subscription state the user has
// configured separately.
//
// POST /v1/me/digest-preference
// Body: {"enabled": true|false}
func (s *Server) HandleSetDigestPreference(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.pgRepo.SetDigestEnabled(r.Context(), user.ID, body.Enabled); err != nil {
		LoggerFromCtx(r.Context()).Error("set digest preference failed", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to save preference")
		return
	}
	respondJSON(w, map[string]bool{"digestEnabled": body.Enabled})
}

// HandleSubscribePush registers (or re-registers) a Web Push subscription
// for the authenticated user. The browser calls this after
// PushManager.subscribe() succeeds; the payload is the subscription
// object as returned by subscription.toJSON().
//
// POST /v1/push/subscribe
// Body: {"endpoint":"https://…","keys":{"p256dh":"…","auth":"…"}}
func (s *Server) HandleSubscribePush(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var body struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Endpoint == "" || body.Keys.P256dh == "" || body.Keys.Auth == "" {
		respondError(w, http.StatusBadRequest, "endpoint, p256dh, and auth are required")
		return
	}

	if err := s.pgRepo.UpsertPushSubscription(r.Context(), user.ID, body.Endpoint, body.Keys.P256dh, body.Keys.Auth); err != nil {
		LoggerFromCtx(r.Context()).Error("push subscribe failed", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to save subscription")
		return
	}
	respondJSON(w, map[string]string{"status": "subscribed"})
}

// HandleUnsubscribePush removes a push subscription for the user.
//
// POST /v1/push/unsubscribe
// Body: {"endpoint":"https://…"}
func (s *Server) HandleUnsubscribePush(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var body struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Endpoint == "" {
		respondError(w, http.StatusBadRequest, "endpoint is required")
		return
	}

	if err := s.pgRepo.DeletePushSubscription(r.Context(), user.ID, body.Endpoint); err != nil {
		LoggerFromCtx(r.Context()).Error("push unsubscribe failed", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to remove subscription")
		return
	}
	respondJSON(w, map[string]string{"status": "unsubscribed"})
}

// HandleVAPIDPublicKey returns the server's VAPID public key so the
// browser can use it in PushManager.subscribe(). Public endpoint — no
// auth required (the key is inherently public; the private half never
// leaves the server).
//
// GET /v1/push/vapid-key
func (s *Server) HandleVAPIDPublicKey(w http.ResponseWriter, r *http.Request) {
	key := s.cfg.VAPIDPublicKey
	if key == "" {
		respondError(w, http.StatusServiceUnavailable, "push notifications not configured")
		return
	}
	respondJSON(w, map[string]string{"publicKey": key})
}

// HandleAdminTestDigest fires a watchlist digest push so admins can
// validate the post-scrape pipeline end-to-end without waiting for
// 15:30 UTC. Pulls the live QuestDB snapshot, then either:
//
//   - default: sends only to the calling admin (safe — `?all=true` is
//     opt-in to avoid accidentally spamming every subscribed user)
//   - ?all=true: full fan-out via SendWatchListDigest
//
// POST /v1/admin/push/test-digest
// Returns 202 Accepted regardless of how many notifications actually
// went out — the dispatch is fire-and-forget like the production path.
// Use the audit log + the recipient device to confirm delivery.
func (s *Server) HandleAdminTestDigest(w http.ResponseWriter, r *http.Request) {
	user := auth.FromContext(r.Context())
	if user.IsGuest() {
		respondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if s.digestRunner == nil {
		respondError(w, http.StatusServiceUnavailable, "push notifications not configured")
		return
	}
	if s.qdbRepo == nil {
		respondError(w, http.StatusServiceUnavailable, "market data unavailable")
		return
	}
	log := LoggerFromCtx(r.Context())

	// Pull the freshest market summary from QuestDB and project it down to
	// the push package's neutral SymbolSnap shape.
	rows, err := s.qdbRepo.GetMarketSummary(r.Context())
	if err != nil {
		log.Error("test-digest: snapshot load failed", "error", err)
		respondError(w, http.StatusInternalServerError, "failed to load market snapshot")
		return
	}
	snapshot := make(map[string]push.SymbolSnap, len(rows))
	for _, row := range rows {
		if row.Symbol == "" {
			continue
		}
		snapshot[row.Symbol] = push.SymbolSnap{
			Symbol:        row.Symbol,
			LastPrice:     row.LastPrice,
			PercentChange: row.PercentChange,
		}
	}
	if len(snapshot) == 0 {
		respondError(w, http.StatusServiceUnavailable, "market snapshot is empty")
		return
	}

	all := r.URL.Query().Get("all") == "true"
	if all {
		// Full fan-out — same code path as the post-scrape hook. Runs in
		// a tracked background goroutine so the HTTP handler returns
		// quickly even when there are dozens of subscribers.
		s.GoBackground(func(ctx context.Context) {
			s.digestRunner.SendWatchListDigest(ctx, snapshot)
		})
		s.auditLog.Log(r.Context(), "push.test-digest.broadcast", "push", "all", map[string]interface{}{
			"admin_id": user.ID,
			"symbols":  len(snapshot),
		})
		log.Info("test-digest: broadcast started", "admin_id", user.ID, "symbols", len(snapshot))
		respondJSON(w, map[string]interface{}{"status": "broadcast queued", "symbols": len(snapshot)})
		return
	}

	// Self-only path. Look up the admin's own watchlist and dispatch
	// just to their subscribed devices.
	watchlist, err := s.pgRepo.GetWatchlistList(r.Context(), user.ID)
	if err != nil {
		log.Error("test-digest: watchlist load failed", "error", err, "user_id", user.ID)
		respondError(w, http.StatusInternalServerError, "failed to load watchlist")
		return
	}
	if len(watchlist) == 0 {
		respondError(w, http.StatusBadRequest, "your watchlist is empty — star a stock first or pass ?all=true")
		return
	}
	s.GoBackground(func(ctx context.Context) {
		s.digestRunner.SendDigestToUser(ctx, user.ID, watchlist, snapshot)
	})
	s.auditLog.Log(r.Context(), "push.test-digest.self", "push", "self", map[string]interface{}{
		"admin_id":      user.ID,
		"symbols":       len(snapshot),
		"watchlist_len": len(watchlist),
	})
	log.Info("test-digest: self-test queued", "admin_id", user.ID, "watchlist_len", len(watchlist))
	respondJSON(w, map[string]interface{}{"status": "self-test queued", "watchlist": len(watchlist)})
}
