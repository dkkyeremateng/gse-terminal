package repository

import (
	"context"
	"fmt"
	"log/slog"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migration is a single forward-only schema change identified by a numeric
// version. Versions are applied in ascending order; each is recorded in
// schema_migrations so a re-run is a no-op. We don't ship "down" migrations
// — rollbacks happen via a new forward migration so the audit trail is
// linear and predictable.
type migration struct {
	Version int
	Name    string
	SQL     string
}

// migrations is the canonical, ordered list. NEVER renumber an existing
// entry — only append new versions to the end. Each entry is exactly one
// SQL block (multiple statements are fine, separated by `;`).
var migrations = []migration{
	{
		Version: 1,
		Name:    "initial schema",
		SQL: `
		CREATE TABLE IF NOT EXISTS users (
			id SERIAL PRIMARY KEY,
			username VARCHAR(255) UNIQUE NOT NULL,
			password_hash VARCHAR(255) NOT NULL,
			role VARCHAR(20) NOT NULL DEFAULT 'user',
			is_locked BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS user_watchlists (
			user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
			symbol VARCHAR(50) NOT NULL,
			added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(user_id, symbol)
		);
		CREATE TABLE IF NOT EXISTS audit_log (
			id SERIAL PRIMARY KEY,
			actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
			actor_username VARCHAR(255),
			action VARCHAR(64) NOT NULL,
			target_type VARCHAR(64),
			target_id VARCHAR(128),
			metadata JSONB,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
		CREATE TABLE IF NOT EXISTS api_keys (
			id SERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			key_hash VARCHAR(64) NOT NULL UNIQUE,
			prefix VARCHAR(24) NOT NULL,
			last_used_at TIMESTAMP WITH TIME ZONE,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
			revoked_at TIMESTAMP WITH TIME ZONE
		);
		CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active ON api_keys(key_hash) WHERE revoked_at IS NULL;
		CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
		CREATE TABLE IF NOT EXISTS sector_overrides (
			symbol VARCHAR(50) PRIMARY KEY,
			sector VARCHAR(64) NOT NULL,
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);
		ALTER TABLE users ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE;
		`,
	},
	{
		Version: 2,
		Name:    "audit_log actor index",
		SQL: `
		CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON audit_log(actor_id);
		`,
	},
	{
		Version: 3,
		Name:    "data quality alerts",
		SQL: `
		CREATE TABLE IF NOT EXISTS data_alerts (
			id SERIAL PRIMARY KEY,
			symbol TEXT NOT NULL,
			trading_date DATE NOT NULL,
			alert_type TEXT NOT NULL,
			severity TEXT NOT NULL DEFAULT 'warning',
			message TEXT NOT NULL,
			metadata JSONB,
			acknowledged BOOLEAN DEFAULT false,
			created_at TIMESTAMPTZ DEFAULT now()
		);
		CREATE INDEX IF NOT EXISTS idx_data_alerts_date ON data_alerts(trading_date DESC);
		CREATE INDEX IF NOT EXISTS idx_data_alerts_ack ON data_alerts(acknowledged) WHERE NOT acknowledged;
		`,
	},
	{
		Version: 4,
		Name:    "daily briefings and market summaries",
		SQL: `
		CREATE TABLE IF NOT EXISTS briefings (
			id SERIAL PRIMARY KEY,
			trading_date DATE NOT NULL,
			symbol TEXT NOT NULL,
			insight JSONB NOT NULL,
			created_at TIMESTAMPTZ DEFAULT now(),
			UNIQUE(trading_date, symbol)
		);
		CREATE TABLE IF NOT EXISTS market_summaries (
			id SERIAL PRIMARY KEY,
			trading_date DATE NOT NULL UNIQUE,
			summary TEXT NOT NULL,
			top_gainers JSONB,
			top_losers JSONB,
			market_sentiment FLOAT,
			created_at TIMESTAMPTZ DEFAULT now()
		);
		`,
	},
	{
		Version: 5,
		Name:    "google oauth columns",
		SQL: `
		ALTER TABLE users ADD COLUMN IF NOT EXISTS provider VARCHAR(32);
		ALTER TABLE users ADD COLUMN IF NOT EXISTS provider_id VARCHAR(255);
		ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
		ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
		CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_id ON users(provider, provider_id) WHERE provider_id IS NOT NULL;
		CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
		`,
	},
	{
		Version: 6,
		Name:    "migrate google_id to provider columns",
		// V5 already created the provider/provider_id/email columns +
		// indexes idempotently. V6's job is just the data migration
		// that backfills existing google_id rows into the new provider
		// columns and drops the legacy column. On a fresh deploy the
		// IF EXISTS branch is skipped entirely.
		SQL: `
		DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='google_id') THEN
				UPDATE users SET provider = 'google', provider_id = google_id WHERE google_id IS NOT NULL AND provider_id IS NULL;
				DROP INDEX IF EXISTS idx_users_google_id;
				ALTER TABLE users DROP COLUMN google_id;
			END IF;
		END $$;
		`,
	},
	{
		Version: 7,
		Name:    "unique email index",
		SQL: `
		DROP INDEX IF EXISTS idx_users_email;
		CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL;
		`,
	},
	{
		Version: 8,
		Name:    "watchlist alert rules + events",
		// alert_rules carries the user-authored predicate; alert_events is
		// the append-only fire log that powers both the in-app bell drawer
		// (via a partial index on unread rows) and the audit trail. Rules
		// disable themselves on fire (see internal/alerts/Evaluator) — the
		// user manually re-arms, preventing loop-spam if a stock stays
		// past threshold across many sessions.
		//
		// CHECK constraints enforce metric and op vocabularies at the DB
		// level so a compromised API key or direct SQL injection can't
		// smuggle in a predicate the evaluator doesn't know how to eval.
		SQL: `
		CREATE TABLE IF NOT EXISTS alert_rules (
			id SERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			symbol VARCHAR(50) NOT NULL,
			metric VARCHAR(20) NOT NULL,
			op VARCHAR(4) NOT NULL,
			threshold DOUBLE PRECISION NOT NULL,
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			last_fired_at TIMESTAMP WITH TIME ZONE,
			fire_count INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
			CONSTRAINT alert_rules_metric_check CHECK (metric IN ('price', 'rsi', 'pct_change')),
			CONSTRAINT alert_rules_op_check CHECK (op IN ('>', '<', '>=', '<='))
		);
		CREATE INDEX IF NOT EXISTS idx_alert_rules_user ON alert_rules(user_id);
		-- Partial index: the evaluator's hot path queries only enabled rules.
		CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled_symbol ON alert_rules(symbol) WHERE enabled = TRUE;

		CREATE TABLE IF NOT EXISTS alert_events (
			id SERIAL PRIMARY KEY,
			rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			symbol VARCHAR(50) NOT NULL,
			metric VARCHAR(20) NOT NULL,
			op VARCHAR(4) NOT NULL,
			threshold DOUBLE PRECISION NOT NULL,
			observed_value DOUBLE PRECISION NOT NULL,
			fired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
			read_at TIMESTAMP WITH TIME ZONE
		);
		-- Unread count query + drawer listing are both per-user, ordered
		-- by fired_at DESC; the partial index makes the unread-badge read
		-- a single B-tree lookup instead of a full scan.
		CREATE INDEX IF NOT EXISTS idx_alert_events_user_unread ON alert_events(user_id, fired_at DESC) WHERE read_at IS NULL;
		CREATE INDEX IF NOT EXISTS idx_alert_events_user_all ON alert_events(user_id, fired_at DESC);
		`,
	},
	{
		Version: 9,
		Name:    "email verification",
		// Adds a boolean email_verified flag + a token table so users who
		// arrive via password (no OAuth) can set + verify an email address
		// before being allowed to create alerts. Pre-existing emails on
		// users.provider IS NOT NULL rows are backfilled to TRUE because
		// the OAuth callback already rejects unverified addresses at
		// auth_handlers.go:320 — any OAuth-sourced email is verified.
		//
		// Manual flow:
		//   1. User submits email → server writes users.email + stamps
		//      email_verified=FALSE, inserts a 24h token, sends the link.
		//   2. Clicking the link hits /auth/verify-email?token=…, which
		//      atomically flips email_verified=TRUE and stamps used_at.
		//   3. Alert POST re-checks email_verified on each request.
		//
		// tokens.token is the random hex (64-char ≥ 256 bits) used as the
		// URL parameter. We don't hash it at rest because the whole row
		// self-destructs in 24h and the DB is already behind admin-only
		// access; storing hashed tokens would add complexity for marginal
		// benefit vs. a rotation here.
		SQL: `
		ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
		UPDATE users SET email_verified = TRUE
		 WHERE email IS NOT NULL AND provider IS NOT NULL AND email_verified = FALSE;

		CREATE TABLE IF NOT EXISTS email_verification_tokens (
			token      VARCHAR(128) PRIMARY KEY,
			user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			email      VARCHAR(255) NOT NULL,
			expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
			used_at    TIMESTAMP WITH TIME ZONE,
			created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_email_verify_tokens_user ON email_verification_tokens(user_id);
		`,
	},
	{
		Version: 10,
		Name:    "purge polluted briefing symbols",
		// Some earlier briefing rows landed with markdown-wrapped or
		// otherwise invalid symbols (e.g. `**ALW**`) because the LLM
		// occasionally emphasised tickers and SaveBriefing didn't
		// validate. The frontend surfaced them as clickable cards that
		// then 400'd at /v1/history. Drop those rows here; SaveBriefing
		// now rejects non-matching symbols at the repo layer so no
		// new pollution can land.
		SQL: `
		DELETE FROM briefings WHERE symbol !~ '^[A-Z0-9]{1,10}$';
		`,
	},
	{
		Version: 12,
		Name:    "portfolio holdings",
		// User-scoped portfolio positions. Each row is one lot —
		// splitting a purchase into two rows at different cost bases is
		// the intended pattern (lets the user track individual buys and
		// average down). Live P&L is computed at query time by joining
		// against the latest market snapshot; no derived columns stored.
		SQL: `
		CREATE TABLE IF NOT EXISTS portfolio_holdings (
			id SERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			symbol VARCHAR(50) NOT NULL,
			quantity DECIMAL(18,4) NOT NULL CHECK (quantity > 0),
			cost_basis DECIMAL(18,4) NOT NULL CHECK (cost_basis >= 0),
			purchase_date DATE NOT NULL,
			notes TEXT DEFAULT '',
			created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_portfolio_user ON portfolio_holdings(user_id);
		`,
	},
	{
		Version: 13,
		Name:    "pro role requests",
		// User-initiated requests to be promoted from 'user' to 'pro'.
		// At most one open (status='pending') row per user is enforced by
		// a partial unique index — the user can reapply after a denial,
		// but can't spam admins by stacking pending requests. Approval
		// is recorded in the same row (decided_at + decided_by + note)
		// rather than a separate decisions table; rejections are equally
		// terminal so the request lifecycle is a single linear state
		// machine: pending → approved | denied.
		SQL: `
		CREATE TABLE IF NOT EXISTS pro_role_requests (
			id SERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			reason TEXT NOT NULL DEFAULT '',
			status VARCHAR(16) NOT NULL DEFAULT 'pending',
			created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
			decided_at TIMESTAMP WITH TIME ZONE,
			decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
			admin_note TEXT NOT NULL DEFAULT '',
			CONSTRAINT pro_role_requests_status_check CHECK (status IN ('pending', 'approved', 'denied'))
		);
		CREATE INDEX IF NOT EXISTS idx_pro_role_requests_user ON pro_role_requests(user_id);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_pro_role_requests_one_pending
			ON pro_role_requests(user_id) WHERE status = 'pending';
		CREATE INDEX IF NOT EXISTS idx_pro_role_requests_pending
			ON pro_role_requests(created_at DESC) WHERE status = 'pending';
		`,
	},
	{
		Version: 11,
		Name:    "push subscriptions",
		// Web Push subscription storage. Each browser/device registers its
		// own subscription object (endpoint URL + encryption keys); a
		// single user may have multiple (phone + desktop). On alert fire,
		// the push service iterates all subscriptions for that user. Stale
		// subscriptions (unsubscribed browser, expired endpoint) are
		// cleaned up lazily when the push provider returns 404/410.
		SQL: `
		CREATE TABLE IF NOT EXISTS push_subscriptions (
			id SERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			endpoint TEXT NOT NULL,
			p256dh TEXT NOT NULL,
			auth_secret TEXT NOT NULL,
			subscribed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(user_id, endpoint)
		);
		CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
		`,
	},
	{
		Version: 14,
		Name:    "watchlist digest opt-out",
		// Per-user toggle for the daily watchlist digest fan-out
		// (push.SendWatchListDigest). Defaults to TRUE so existing
		// subscribers keep receiving digests without an opt-in step;
		// users who want only alert-rule notifications (not the daily
		// summary) can flip it via POST /v1/me/digest-preference. The
		// fan-out query in ListWatchListsForPushSubscribers filters
		// on this column so a FALSE value is enough to silence the
		// daily digest while leaving alert pushes untouched.
		SQL: `
		ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT TRUE;
		`,
	},
	{
		Version: 15,
		Name:    "case-insensitive username uniqueness",
		// Companion to the Go-level normalisation in
		// internal/auth/username.go (NormalizeUsername / ValidateUsername /
		// SanitizeUsername). The Go side prevents new mixed-case rows from
		// landing, but pre-existing rows from before the lowercase regime
		// could still differ only in case ("Admin" vs "admin"), creating
		// the impersonation risk the audit flagged. This migration:
		//
		//   1. Resolves any legacy case-only collisions deterministically.
		//      For each group of rows that lowercases to the same handle,
		//      the row with the smallest id keeps its identity (after
		//      lowercasing) and the rest get suffixed (`<lower>_2`,
		//      `<lower>_3`, …). The suffix loop guards against collisions
		//      with already-suffixed names. Choosing the lowest-id row as
		//      the keeper is stable across re-runs and biases towards the
		//      account that signed up first — typically the legitimate
		//      one if a lookalike was added later.
		//
		//   2. Lowercases every remaining username so the existing
		//      column-level UNIQUE (idx since migration 1) becomes a
		//      de-facto case-insensitive constraint.
		//
		//   3. Adds a UNIQUE INDEX on LOWER(username) as belt-and-suspenders.
		//      Future inserts that bypass the Go-level normalisation
		//      (direct SQL, a forgotten code path) hit the LOWER index
		//      instead of producing a silent collision-prone row.
		//
		// Migration is wrapped in the runMigrations transaction; a partial
		// failure rolls back cleanly.
		SQL: `
		DO $$
		DECLARE
			r RECORD;
			new_name TEXT;
			suffix INTEGER;
		BEGIN
			FOR r IN
				SELECT id, username FROM users
				WHERE id NOT IN (
					SELECT MIN(id) FROM users GROUP BY LOWER(username)
				)
				ORDER BY id ASC
			LOOP
				suffix := 2;
				new_name := LOWER(r.username) || '_' || suffix;
				WHILE EXISTS (SELECT 1 FROM users WHERE LOWER(username) = new_name) LOOP
					suffix := suffix + 1;
					new_name := LOWER(r.username) || '_' || suffix;
				END LOOP;
				UPDATE users SET username = new_name WHERE id = r.id;
			END LOOP;
		END $$;

		UPDATE users SET username = LOWER(username) WHERE username <> LOWER(username);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
		`,
	},
}

// runMigrations applies every migration whose version is greater than the
// max version recorded in schema_migrations. Each migration runs inside its
// own transaction so a partial failure leaves the DB in a known state.
func runMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	rows, err := pool.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	applied := map[int]bool{}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()

	pending := make([]migration, 0)
	for _, m := range migrations {
		if !applied[m.Version] {
			pending = append(pending, m)
		}
	}
	sort.Slice(pending, func(i, j int) bool { return pending[i].Version < pending[j].Version })

	for _, m := range pending {
		slog.Info("Applying migration", "version", m.Version, "name", m.Name)
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("migration %d begin: %w", m.Version, err)
		}
		if _, err := tx.Exec(ctx, m.SQL); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("migration %d (%s) failed: %w", m.Version, m.Name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, m.Version, m.Name); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("migration %d record: %w", m.Version, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("migration %d commit: %w", m.Version, err)
		}
	}
	return nil
}
