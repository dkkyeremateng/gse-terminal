package server

import (
	"context"
	"encoding/json"
	"fmt"
	htmlpkg "html"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/teckdroids/ges-data-engine/internal/audit"
	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// maxUploadBytes caps the entire multipart upload — including form fields,
// not just the file payload — so a malicious client can't OOM the server with
// a multi-GB body. 32 MB matches the chi rate limiter's "destructive admin"
// scoping and is well above any legitimate daily CSV.
const maxUploadBytes = 32 << 20

func (s *Server) HandleUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		http.Error(w, "Upload too large or malformed", http.StatusRequestEntityTooLarge)
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Failed to get file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	res, err := s.ingestor.Ingest(r.Context(), file)

	// All cached DB reads are namespaced under "gse:data:*". A single SCAN+DEL
	// pass nukes them so the next request hydrates from fresh equities data.
	// Rate limiters / sessions / API key activity (under different prefixes)
	// stay intact.
	if perr := s.redisRepo.InvalidatePattern(r.Context(), "gse:data:*"); perr != nil {
		LoggerFromCtx(r.Context()).Warn("cache invalidation failed", "pattern", "gse:data:*", "error", perr)
	}
	// LLM-generated artifacts live under "gse:llm:*" specifically so the
	// daily scrape doesn't wipe them on every run (and burst the Gemini
	// quota as users browse). But a manual CSV upload means the
	// underlying price history just changed — regenerate insights from
	// fresh data next time someone asks.
	if perr := s.redisRepo.InvalidatePattern(r.Context(), "gse:llm:*"); perr != nil {
		LoggerFromCtx(r.Context()).Warn("cache invalidation failed", "pattern", "gse:llm:*", "error", perr)
	}

	// Tell every connected client to drop its own in-memory caches too —
	// otherwise a tab that loaded before the upload keeps serving the old
	// briefing/symbols/insight for up to their per-key TTL. The Hub's
	// send-slot eviction path covers slow clients so this never blocks.
	s.broadcastCacheBust()

	if err != nil {
		if wantsJSON(r) {
			respondError(w, http.StatusInternalServerError, fmt.Sprintf("Error during ingestion: %s", err.Error()))
			return
		}
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusInternalServerError)
		// Ingest errors can surface row content / column values that came
		// from the uploaded CSV. Escape before emitting into HTML so a
		// crafted CSV can't stage stored XSS against the admin view.
		fmt.Fprintf(w, `<div class="text-red-400 bg-slate-900 p-4 rounded border border-red-900">Error during ingestion: %s</div>`, htmlpkg.EscapeString(err.Error()))
		return
	}

	s.auditLog.Log(r.Context(), audit.ActionDataUpload, "ingestion", "csv", map[string]interface{}{
		"inserted": res.Inserted,
		"skipped":  res.Skipped,
	})

	// Regenerate daily briefing in the background with fresh data.
	// goBackground joins shutdown via the server's bgCtx + WaitGroup so
	// a SIGTERM mid-LLM-call doesn't leak a goroutine after the process
	// starts tearing down.
	if s.briefingSvc != nil && res.Inserted > 0 {
		s.goBackground(func(ctx context.Context) {
			s.regenerateBriefing(ctx)
		})
	}

	// Evaluate watchlist alerts against the freshly ingested data. Runs
	// separately from the briefing regen so a slow LLM call doesn't
	// block the user-facing email/WS notifications.
	if s.alertEvaluator != nil && s.qdbRepo != nil && res.Inserted > 0 {
		s.goBackground(func(ctx context.Context) {
			s.evaluateAlerts(ctx)
		})
	}

	// Fan out the watchlist digest push so subscribed users get the
	// fresh snapshot even when the data update came from an admin CSV
	// upload outside the daily 15:30 UTC scrape window. Same dedupe
	// tag as the scheduled scrape — multiple uploads on the same day
	// replace rather than duplicate notifications.
	if s.digestRunner != nil && s.qdbRepo != nil && res.Inserted > 0 {
		s.goBackground(func(ctx context.Context) {
			s.dispatchUploadDigest(ctx)
		})
	}

	if wantsJSON(r) {
		respondJSON(w, map[string]int{"inserted": res.Inserted, "skipped": res.Skipped})
		return
	}
	w.Header().Set("Content-Type", "text/html")
	if res.Skipped > 0 {
		fmt.Fprintf(w, `<div class="text-amber-400 bg-slate-900 p-4 rounded border border-amber-900">Ingested %d rows, skipped %d malformed rows. Check server logs for details.</div>`, res.Inserted, res.Skipped)
	} else {
		fmt.Fprintf(w, `<div class="text-green-400 bg-slate-900 p-4 rounded border border-green-900">Successfully ingested %d rows!</div>`, res.Inserted)
	}
}

// regenerateBriefing fetches the current symbol list and regenerates
// today's daily briefing with the freshly uploaded data. Accepts a
// parent context (from goBackground → bgCtx) so graceful shutdown
// can cancel an in-flight LLM call instead of letting it outlive the
// process. The 3-minute timeout is a per-invocation cap on top of the
// parent's shutdown signal.
func (s *Server) regenerateBriefing(parent context.Context) {
	logger := slog.With("component", "post-upload-briefing")
	ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
	defer cancel()

	tradingDate := time.Now().UTC().Format("2006-01-02")

	// Skip if today's briefing already exists — avoids redundant LLM
	// calls when multiple uploads happen in the same session.
	if existing, err := s.pgRepo.GetLatestBriefing(ctx); err == nil && existing != nil && existing.TradingDate == tradingDate {
		logger.Info("Daily briefing already exists, skipping regeneration", "date", tradingDate)
		return
	}

	symbols, err := s.qdbRepo.GetSymbols(ctx)
	if err != nil {
		logger.Warn("Cannot regenerate briefing: symbol lookup failed", "error", err)
		return
	}
	if len(symbols) == 0 {
		// GetSymbols windows back 3 months from the newest trading_date, so
		// an empty list means the equities table itself is empty — not that
		// the uploaded data is too old.
		logger.Warn("Cannot regenerate briefing: equities table has no symbols")
		return
	}

	top := symbols
	if len(top) > 10 {
		top = top[:10]
	}

	insights, err := s.briefingSvc.GenerateDailyBriefing(ctx, top)
	if err != nil {
		logger.Warn("Briefing generation failed after upload", "error", err)
		return
	}

	for _, ins := range insights {
		insJSON, _ := json.Marshal(ins)
		if err := s.pgRepo.SaveBriefing(ctx, tradingDate, ins.Symbol, insJSON); err != nil {
			logger.Warn("Failed to save briefing", "symbol", ins.Symbol, "error", err)
		}
	}

	summary, err := s.briefingSvc.GenerateMarketSummary(ctx, insights)
	if err != nil {
		logger.Warn("Market summary generation failed after upload", "error", err)
		return
	}

	var avgSentiment float64
	for _, ins := range insights {
		avgSentiment += ins.Sentiment
	}
	if len(insights) > 0 {
		avgSentiment /= float64(len(insights))
	}

	if err := s.pgRepo.SaveMarketSummary(ctx, tradingDate, summary, nil, nil, avgSentiment); err != nil {
		logger.Warn("Failed to save market summary after upload", "error", err)
	} else {
		logger.Info("Daily briefing regenerated after upload", "date", tradingDate, "symbols", len(insights))
	}
}

// revokeUserSessions invalidates every outstanding session for userID —
// access JWTs and refresh cookies alike — by bumping the user's session
// epoch. Call it from any admin action that changes what the user's
// existing sessions are entitled to do.
//
// Without this, a role change was purely cosmetic on live sessions: the
// current JWT carried the old role until it expired, and silent refresh
// then minted a *fresh* one from the role cached in Redis at login time,
// sliding the 90-day refresh TTL forward each time. A demoted admin kept
// admin for as long as they kept browsing.
//
// Soft-fail: Postgres is the durable source of truth and the next login
// re-reads it. Log loudly, because a failure here means the revocation
// the operator just performed silently did not take effect on live
// sessions — exactly the condition this function exists to prevent.
func (s *Server) revokeUserSessions(r *http.Request, userID int, reason string) {
	if s.redisRepo == nil {
		return
	}
	epoch, err := s.redisRepo.BumpSessionEpoch(r.Context(), userID)
	if err != nil {
		LoggerFromCtx(r.Context()).Error(
			"[admin] session revocation failed; the user's existing sessions retain their previous privileges until expiry",
			"error", err, "user_id", userID, "reason", reason)
		return
	}
	LoggerFromCtx(r.Context()).Info("[admin] sessions revoked",
		"user_id", userID, "reason", reason, "epoch", epoch)
}

func (s *Server) HandleAdminUsersList(w http.ResponseWriter, r *http.Request) {
	users, err := s.pgRepo.GetAllUsers(r.Context())
	if err != nil {
		if wantsJSON(r) {
			respondError(w, http.StatusInternalServerError, "Failed to fetch users")
			return
		}
		http.Error(w, "Failed to fetch users", http.StatusInternalServerError)
		return
	}

	// SPA caller (Accept: application/json) — return the raw list and skip
	// the HTMX HTML render below.
	if wantsJSON(r) {
		if users == nil {
			users = []repository.User{}
		}
		respondJSON(w, users)
		return
	}

	// HTMX contract: this response is the *innerHTML* of
	// `#users-table-container` (defined in ui/admin.html). Every trigger
	// in the rendered table below pins `hx-swap="innerHTML"` explicitly
	// so we don't rely on the global default — if a future change flips
	// the default to outerHTML, the container (which carries
	// hx-get="/v1/admin/users" + hx-trigger="load, users-refresh from:body")
	// would be replaced by these contents and the auto-refresh wiring
	// would silently disappear.
	w.Header().Set("Content-Type", "text/html")
	var html strings.Builder
	html.WriteString(`<div class="overflow-x-auto"><table class="w-full text-xs text-left text-slate-400 border border-white/5 whitespace-nowrap">`)
	html.WriteString(`<thead class="bg-white/[0.03]"><tr>`)
	html.WriteString(`<th class="px-4 py-3 border-r border-white/5 font-black uppercase text-[10px] text-slate-500">ID</th>`)
	html.WriteString(`<th class="px-4 py-3 border-r border-white/5 font-black uppercase text-[10px] text-slate-500">Username</th>`)
	html.WriteString(`<th class="px-4 py-3 border-r border-white/5 font-black uppercase text-[10px] text-slate-500">Role</th>`)
	html.WriteString(`<th class="px-4 py-3 border-r border-white/5 font-black uppercase text-[10px] text-slate-500 text-center">Status</th>`)
	html.WriteString(`<th class="px-4 py-3 border-r border-white/5 font-black uppercase text-[10px] text-slate-500">Created At</th>`)
	html.WriteString(`<th class="px-4 py-3 font-black uppercase text-[10px] text-slate-500 text-center">Actions</th>`)
	html.WriteString(`</tr></thead><tbody>`)

	for _, u := range users {
		html.WriteString(fmt.Sprintf(`<tr class="border-b border-white/5 hover:bg-white/[0.01] transition-colors" id="user-row-%d">`, u.ID))
		html.WriteString(fmt.Sprintf(`<td class="px-4 py-3 border-r border-white/5">%d</td>`, u.ID))
		// Usernames are user-chosen at signup — escape before rendering.
		// Without this, `<script>…</script>` in a username runs JS in every
		// admin's browser when they view this list.
		safeUsername := htmlpkg.EscapeString(u.Username)
		html.WriteString(fmt.Sprintf(`<td class="px-4 py-3 border-r border-white/5 font-bold text-white/70">%s</td>`, safeUsername))

		// Role cell — dropdown so the admin can promote/demote across all
		// five tiers. Inline RGB styles are used because Tailwind's CDN JIT
		// only scans the DOM at page load; classes injected later via HTMX
		// swaps never get compiled, so dynamic colour classes silently fall
		// back to a single hue. Inline styles avoid the issue entirely.
		type roleStyle struct{ fg, bg, border string }
		roleStyles := map[string]roleStyle{
			"user":    {fg: "#cbd5e1", bg: "rgba(100,116,139,0.10)", border: "rgba(100,116,139,0.35)"},
			"pro":     {fg: "#60a5fa", bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.35)"},
			"analyst": {fg: "#818cf8", bg: "rgba(99,102,241,0.10)", border: "rgba(99,102,241,0.35)"},
			"bot":     {fg: "#c084fc", bg: "rgba(168,85,247,0.10)", border: "rgba(168,85,247,0.35)"},
			"admin":   {fg: "#34d399", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.35)"},
		}
		st, ok := roleStyles[u.Role]
		if !ok {
			st = roleStyles["user"]
		}

		var roleOptions strings.Builder
		for _, role := range []string{"user", "pro", "analyst", "bot", "admin"} {
			selected := ""
			if u.Role == role {
				selected = " selected"
			}
			fmt.Fprintf(&roleOptions, `<option value="%s"%s style="background:#0f172a;color:#fff;">%s</option>`,
				role, selected, strings.ToUpper(role[:1])+role[1:])
		}

		selectStyle := fmt.Sprintf(
			"color:%s;background-color:%s;border:1px solid %s;",
			st.fg, st.bg, st.border,
		)

		html.WriteString(fmt.Sprintf(`<td class="px-4 py-3 border-r border-white/5">
			<select name="role"
			        hx-post="/v1/admin/users/%d/role"
			        hx-trigger="change"
			        hx-target="#users-table-container"
			        hx-swap="innerHTML"
			        hx-include="this"
			        style="%s"
			        class="role-pill rounded px-2 py-1 font-black uppercase text-[9px] tracking-widest cursor-pointer transition-all focus:outline-none appearance-none">
				%s
			</select>
		</td>`, u.ID, selectStyle, roleOptions.String()))

		// Status cell with Lock/Unlock
		statusColor := "emerald"
		statusLabel := "Active"
		if u.IsLocked {
			statusColor = "rose"
			statusLabel = "Locked"
		}

		if u.Role == "admin" {
			html.WriteString(`<td class="px-4 py-3 border-r border-white/5 text-center">
				<span class="px-2 py-1 rounded bg-slate-500/10 text-slate-500 border border-white/5 font-black uppercase text-[9px] tracking-widest">
					Immune
				</span>
			</td>`)
		} else {
			html.WriteString(fmt.Sprintf(`<td class="px-4 py-3 border-r border-white/5 text-center">
				<button hx-post="/v1/admin/users/%d/lock?locked=%t"
						hx-target="#users-table-container"
						hx-swap="innerHTML"
						class="px-2 py-1 rounded bg-%s-500/10 text-%s-400 border border-%s-500/20 font-black uppercase text-[9px] tracking-widest hover:bg-%s-500/20 transition-all">
					%s
				</button>
			</td>`, u.ID, !u.IsLocked, statusColor, statusColor, statusColor, statusColor, statusLabel))
		}

		html.WriteString(fmt.Sprintf(`<td class="px-4 py-3 border-r border-white/5 text-[10px]">%s</td>`, u.CreatedAt.Format("Jan 02, 2006 15:04")))

		// Actions Cell — reset-password button uses data-action dispatch
		// (no inline onclick, CSP-friendly) and passes the username via a
		// data-attribute escaped with html.EscapeString. Previous version
		// interpolated raw u.Username into a JS string literal
		// ('%s'), letting a crafted username escape the quote and execute
		// arbitrary JS in any admin's browser.
		html.WriteString(fmt.Sprintf(`<td class="px-4 py-3 flex items-center justify-center gap-3">
			<button data-action="admin-reset-password" data-user-id="%d" data-username="%s"
			        class="p-1.5 hover:bg-white/5 rounded-lg text-slate-500 hover:text-blue-400 transition-all"
			        title="Reset Password">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path></svg>
			</button>
			<button hx-delete="/v1/admin/users/%d"
			        hx-confirm="Are you sure you want to PERMANENTLY revoke this user identity?"
			        hx-target="#users-table-container"
			        hx-swap="innerHTML"
			        class="p-1.5 hover:bg-rose-500/10 rounded-lg text-slate-500 hover:text-rose-400 transition-all"
			        title="Delete User">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
			</button>
		</td>`, u.ID, safeUsername, u.ID))

		html.WriteString(`</tr>`)
	}

	html.WriteString(`</tbody></table></div>`)
	w.Write([]byte(html.String()))
}

func (s *Server) HandleAdminUserUpdateRole(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "Invalid user ID", http.StatusBadRequest)
		return
	}
	// Accept either query string (legacy) or form body (HTMX <select>).
	newRole := r.URL.Query().Get("role")
	if newRole == "" {
		newRole = r.FormValue("role")
	}

	// Allowed roles: user (default), pro (premium read+features), analyst
	// (read-only premium), bot (api-only machine principal), admin.
	switch newRole {
	case "user", "pro", "analyst", "bot", "admin":
	default:
		respondError(w, http.StatusBadRequest, "Invalid role")
		return
	}

	// Prevent self-demotion lockout. If the acting admin is demoting
	// themselves to a non-admin role, reject — they need another admin
	// to perform the demotion, or they need to promote someone else
	// first. Without this, a lone admin can misclick the dropdown and
	// lose all admin access with no in-app recovery path.
	if callerID, ok := r.Context().Value(auth.UserIDKey).(int); ok && callerID == id && newRole != "admin" {
		respondError(w, http.StatusBadRequest, "You cannot demote yourself. Promote another user to admin first.")
		return
	}

	err = s.pgRepo.UpdateUserRole(r.Context(), id, newRole)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Update failed")
		return
	}

	// The new role only reaches the user's sessions if we invalidate the
	// old ones — both the JWT they are holding and the role cached
	// alongside their refresh token. They re-authenticate and pick the
	// new role up on the next login.
	s.revokeUserSessions(r, id, "role_change")

	s.auditLog.Log(r.Context(), audit.ActionUserRoleSet, "Update", "Role", map[string]interface{}{
		"role": newRole,
	})

	if wantsJSON(r) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.HandleAdminUsersList(w, r)
}

func (s *Server) HandleAdminUserResetPassword(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "Invalid user ID", http.StatusBadRequest)
		return
	}
	newPassword := r.FormValue("password")

	if err := auth.ValidatePassword(newPassword); err != nil {
		if wantsJSON(r) {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	err = s.pgRepo.UpdateUserPassword(r.Context(), id, newPassword)
	if err != nil {
		if wantsJSON(r) {
			respondError(w, http.StatusInternalServerError, "Reset failed")
			return
		}
		http.Error(w, "Reset failed", http.StatusInternalServerError)
		return
	}

	s.auditLog.Log(r.Context(), audit.ActionUserPwdReset, "Update", "Password", nil)

	if wantsJSON(r) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "text/html")
	w.Write([]byte(`<span class="text-emerald-400 text-[10px] font-black uppercase tracking-widest animate-pulse">Identity Verified: Credentials Reset</span>`))
}

func (s *Server) HandleAdminUserDelete(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "Invalid user ID", http.StatusBadRequest)
		return
	}

	err = s.pgRepo.DeleteUser(r.Context(), id)
	if err != nil {
		if wantsJSON(r) {
			respondError(w, http.StatusInternalServerError, "Deletion failed")
			return
		}
		http.Error(w, "Deletion failed", http.StatusInternalServerError)
		return
	}

	// The row is gone but the credentials are not: the access JWT is
	// self-contained and the refresh record lives in Redis with its own
	// 90-day TTL, and silent refresh never re-checks Postgres. Without
	// this bump a deleted account keeps a working session.
	s.revokeUserSessions(r, id, "user_deleted")

	s.auditLog.Log(r.Context(), audit.ActionUserDelete, "Delete", "Account", nil)

	if wantsJSON(r) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.HandleAdminUsersList(w, r)
}

func (s *Server) HandleAdminUserToggleLock(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, "Invalid user ID", http.StatusBadRequest)
		return
	}
	lockedStr := r.URL.Query().Get("locked")
	locked := lockedStr == "true"

	err = s.pgRepo.UpdateUserLockStatus(r.Context(), id, locked)
	if err != nil {
		if wantsJSON(r) {
			respondError(w, http.StatusInternalServerError, "Update failed")
			return
		}
		http.Error(w, "Update failed", http.StatusInternalServerError)
		return
	}

	// Mirror the lock state to Redis so the silent-refresh path
	// (auth.silentRefresh) refuses to mint new access JWTs for this
	// user. Without this, a locked user's existing refresh cookie
	// would keep rebuilding 24h sessions indefinitely — the lock would
	// only kick in after the user goes idle for 90 days. Soft-fail on
	// Redis errors: the Postgres lock is the durable source of truth
	// and any user re-login lookup would still surface the locked
	// state (HandleLoginPost rejects locked accounts at the password
	// check); the Redis sentinel is best-effort acceleration of the
	// existing-session kick.
	if s.redisRepo != nil {
		if locked {
			if err := s.redisRepo.MarkUserLocked(r.Context(), id, auth.RefreshTokenTTL); err != nil {
				LoggerFromCtx(r.Context()).Warn("[admin] failed to mark user locked in redis", "error", err, "user_id", id)
			}
		} else {
			if err := s.redisRepo.ClearUserLock(r.Context(), id); err != nil {
				LoggerFromCtx(r.Context()).Warn("[admin] failed to clear user lock in redis", "error", err, "user_id", id)
			}
		}
	}

	// The lock sentinel above only gates silent refresh, so a locked user
	// keeps whatever access JWT they already hold until it expires — up
	// to 24h of continued access after being locked out. Bumping the
	// epoch closes that window; the sentinel stays because it is what
	// keeps their refresh cookie dead afterwards.
	//
	// Only on lock. Unlocking does not need to invalidate anything, and
	// bumping there would sign out a user we just restored.
	if locked {
		s.revokeUserSessions(r, id, "user_locked")
	}

	status := "unlocked"
	if locked {
		status = "locked"
	}

	s.auditLog.Log(r.Context(), audit.ActionUserStatus, "Update", "Status", map[string]interface{}{
		"status": status,
	})

	if wantsJSON(r) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.HandleAdminUsersList(w, r)
}
