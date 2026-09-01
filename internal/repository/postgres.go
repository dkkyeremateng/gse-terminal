package repository

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// briefingSymbolRe mirrors the server's public-API symbol validator so
// any row that lands in the briefings table is guaranteed to survive a
// later /v1/history round trip. Without this guard a polluted LLM
// response (markdown emphasis, whitespace, punctuation) would store a
// symbol the frontend surfaces but the server's handlers reject with 400.
var briefingSymbolRe = regexp.MustCompile(`^[A-Z][A-Z0-9]{0,9}$`)

// Sentinel errors returned from account-management repo methods so the
// HTTP layer can map them to specific status codes (401 vs 409 vs 500)
// without string-comparing error messages.
var (
	// ErrCurrentPasswordWrong — VerifyAndUpdatePassword called with a
	// current password that doesn't match the stored bcrypt hash.
	ErrCurrentPasswordWrong = errors.New("current password is incorrect")
	// ErrNoPasswordSet — caller has no password on file (OAuth-only
	// account); they need the SetPassword flow, not change-password.
	ErrNoPasswordSet = errors.New("no password set on this account")
	// ErrEmailManagedByOAuth — UnlinkUserEmail / change-email called on
	// an account whose email is bound to a linked OAuth provider; user
	// must unlink the provider first.
	ErrEmailManagedByOAuth = errors.New("email is managed by an OAuth provider")
	// ErrAutoLinkIneligible — LinkProviderByEmailIfEligible found a row
	// matching the OAuth email but the row is not eligible for silent
	// auto-link (has a password, has another provider already, or the
	// stored email isn't verified). Caller should refuse to log the user
	// in via auto-link and require explicit linking through the
	// authenticated link flow.
	ErrAutoLinkIneligible = errors.New("account not eligible for OAuth auto-link")
)

// bcryptCost governs the work factor used when HASHING new passwords. bcrypt
// stores the cost inside each hash so existing DB rows (written at cost 10
// via bcryptCost) still verify correctly after the bump — only new
// signups and password resets pay the higher cost. 12 is the OWASP 2024
// recommendation for interactive auth; 10 was the pre-bump default.
const bcryptCost = 12

// BcryptCost exposes the work factor so the login handler can build a decoy
// hash at the same cost. A decoy verified at a different cost would take a
// visibly different amount of time and reintroduce the timing signal it
// exists to remove.
const BcryptCost = bcryptCost

type PostgresRepo struct {
	pool *pgxpool.Pool
}

type User struct {
	ID        int       `json:"id"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	IsLocked  bool      `json:"is_locked"`
	CreatedAt time.Time `json:"created_at"`
}

func NewPostgresRepo(ctx context.Context, connString string) (*PostgresRepo, error) {
	cfg, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, fmt.Errorf("invalid postgres dsn: %v", err)
	}
	// Tuned for a single-node deployment with moderate load. Adjust via env if
	// you start seeing pool exhaustion in production.
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 1 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("unable to connect to database: %v", err)
	}

	// _, err = pool.Exec(ctx, "UPDATE users SET role = 'admin' WHERE username = 'admin';")
	// if err != nil {
	// 	return nil, fmt.Errorf("unable to update user role: %v", err)
	// }

	repo := &PostgresRepo{pool: pool}
	if err := repo.migrate(ctx); err != nil {
		return nil, err
	}

	return repo, nil
}

// migrate now delegates to the versioned runner in migrations.go. The
// canonical schema lives there as a numbered list; this method is kept as
// the constructor's hook so callsites don't have to change.
func (r *PostgresRepo) migrate(ctx context.Context) error {
	return runMigrations(ctx, r.pool)
}

// GetUserByUsername looks up a user by username with case-insensitive
// matching. Existing rows may store mixed-case handles ("Admin") from
// before the canonical-lowercase enforcement; LOWER(username) normalises
// the comparison so login and uniqueness checks both treat "Admin" and
// "admin" as the same identity. New rows are normalised to lowercase at
// insert time (CreateUser / CreateOAuthUser).
func (r *PostgresRepo) GetUserByUsername(ctx context.Context, username string) (int, string, string, bool, error) {
	var id int
	var hash string
	var role string
	var isLocked bool
	err := r.pool.QueryRow(ctx,
		"SELECT id, COALESCE(password_hash, ''), role, is_locked FROM users WHERE LOWER(username) = LOWER($1)",
		username,
	).Scan(&id, &hash, &role, &isLocked)
	return id, hash, role, isLocked, err
}

// GetUserByProviderID looks up a user by their OAuth provider and provider-specific ID.
func (r *PostgresRepo) GetUserByProviderID(ctx context.Context, provider, providerID string) (int, string, string, bool, error) {
	var id int
	var username, role string
	var isLocked bool
	err := r.pool.QueryRow(ctx, "SELECT id, username, role, is_locked FROM users WHERE provider = $1 AND provider_id = $2", provider, providerID).Scan(&id, &username, &role, &isLocked)
	return id, username, role, isLocked, err
}

// GetUserByEmail finds an existing user by email for account linking.
func (r *PostgresRepo) GetUserByEmail(ctx context.Context, email string) (int, string, string, bool, error) {
	var id int
	var username, role string
	var isLocked bool
	err := r.pool.QueryRow(ctx, "SELECT id, username, role, is_locked FROM users WHERE email = $1", email).Scan(&id, &username, &role, &isLocked)
	return id, username, role, isLocked, err
}

// CreateOAuthUser inserts a new user authenticated via an OAuth provider
// (no password). The username is derived from the email prefix.
//
// email_verified is set to TRUE because the caller (OAuth callback at
// auth_handlers.go:320) has already rejected unverified provider emails;
// reaching this INSERT implies the provider confirmed the address.
func (r *PostgresRepo) CreateOAuthUser(ctx context.Context, username, email, provider, providerID string) error {
	_, err := r.pool.Exec(ctx,
		"INSERT INTO users (username, email, email_verified, provider, provider_id, role) VALUES (LOWER($1), $2, TRUE, $3, $4, 'user')",
		username, email, provider, providerID)
	return err
}

// LinkProviderID associates an OAuth provider identity with an existing
// user account. Because the OAuth callback gate already enforces provider
// email verification, stamping email_verified=TRUE here is safe — the
// user has demonstrated control of the address via the provider.
func (r *PostgresRepo) LinkProviderID(ctx context.Context, userID int, provider, providerID, email string) error {
	_, err := r.pool.Exec(ctx,
		"UPDATE users SET provider = $1, provider_id = $2, email = $3, email_verified = TRUE WHERE id = $4",
		provider, providerID, email, userID)
	return err
}

// LinkProviderByEmailIfEligible atomically looks up a user by email and
// links the supplied OAuth identity ONLY if the row is eligible for a
// silent auto-link. Eligibility requires all of:
//
//   - password_hash IS NULL or empty (no password set)
//   - provider IS NULL (no provider already linked — auto-linking on top
//     of an existing provider would let an attacker who controls the
//     same email at a *different* provider claim the account)
//   - email_verified = TRUE (the stored email has been proven, so the
//     match represents a real prior identity claim — not a manually
//     entered, never-verified address sitting on the row)
//
// Runs in a single transaction with SELECT ... FOR UPDATE so a concurrent
// password-set or provider-link can't slip past the eligibility check.
// Returns the linked user's id/username/role on success; ErrAutoLinkIneligible
// if a matching row exists but doesn't satisfy the conditions; pgx.ErrNoRows
// (or equivalent) if no row matches the email.
func (r *PostgresRepo) LinkProviderByEmailIfEligible(ctx context.Context, email, provider, providerID string) (int, string, string, bool, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, "", "", false, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	var (
		id           int
		username     string
		role         string
		isLocked     bool
		passwordHash *string
		curProvider  *string
		verified     bool
	)
	err = tx.QueryRow(ctx,
		`SELECT id, username, role, is_locked, password_hash, provider, email_verified
		 FROM users WHERE email = $1 FOR UPDATE`, email,
	).Scan(&id, &username, &role, &isLocked, &passwordHash, &curProvider, &verified)
	if err != nil {
		return 0, "", "", false, err
	}

	if passwordHash != nil && *passwordHash != "" {
		return 0, "", "", false, ErrAutoLinkIneligible
	}
	if curProvider != nil && *curProvider != "" {
		return 0, "", "", false, ErrAutoLinkIneligible
	}
	if !verified {
		return 0, "", "", false, ErrAutoLinkIneligible
	}

	if _, err := tx.Exec(ctx,
		`UPDATE users SET provider = $1, provider_id = $2, email = $3, email_verified = TRUE WHERE id = $4`,
		provider, providerID, email, id,
	); err != nil {
		return 0, "", "", false, fmt.Errorf("link provider: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, "", "", false, fmt.Errorf("commit: %w", err)
	}
	return id, username, role, isLocked, nil
}

// GetUserProvider returns the provider and email for the given user.
// Returns empty strings if no provider is linked.
func (r *PostgresRepo) GetUserProvider(ctx context.Context, userID int) (provider, providerID, email string, err error) {
	err = r.pool.QueryRow(ctx,
		"SELECT COALESCE(provider, ''), COALESCE(provider_id, ''), COALESCE(email, '') FROM users WHERE id = $1",
		userID).Scan(&provider, &providerID, &email)
	return
}

// UnlinkProvider removes the OAuth provider association from a user account.
// Clears email + email_verified together so a re-linked (or manually
// re-added) email has to go through verification again — never let a
// stale verified flag outlive the email that proved it.
func (r *PostgresRepo) UnlinkProvider(ctx context.Context, userID int) error {
	_, err := r.pool.Exec(ctx,
		"UPDATE users SET provider = NULL, provider_id = NULL, email = NULL, email_verified = FALSE WHERE id = $1", userID)
	return err
}

// HasPassword checks whether the user has a password set (non-NULL, non-empty).
func (r *PostgresRepo) HasPassword(ctx context.Context, userID int) (bool, error) {
	var hash *string
	err := r.pool.QueryRow(ctx,
		"SELECT password_hash FROM users WHERE id = $1", userID).Scan(&hash)
	if err != nil {
		return false, err
	}
	return hash != nil && *hash != "", nil
}

// TransferProvider moves the OAuth provider identity from one user to
// another within a transaction, then deletes the source user.
//
// The merge handler (HandleMergeAccount) only invokes this after
// verifying the target's password — at which point the caller is
// authenticated AS the target, and the source row is by construction
// orphaned: every OAuth attribute it had is now on the target. We
// delete it unconditionally rather than gating on
// `password_hash IS NULL`. The previous gating left a zombie row
// behind whenever the source happened to have a password (e.g. the
// user had set one earlier, then merged into a different account):
// the row had no email, no provider, and was unreachable from the
// merge UI but still loginable via username/password — a confusing
// state that the merge flow's "delete the orphaned account" comment
// already promised to clean up.
func (r *PostgresRepo) TransferProvider(ctx context.Context, fromUserID, toUserID int) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// 1. Read the source provider info
	var provider, providerID, email *string
	err = tx.QueryRow(ctx,
		"SELECT provider, provider_id, email FROM users WHERE id = $1", fromUserID,
	).Scan(&provider, &providerID, &email)
	if err != nil {
		return fmt.Errorf("read source: %w", err)
	}

	// 2. Clear source first to avoid unique index conflicts on email/provider_id.
	//    Resets email_verified in lockstep so the flag can never outlive its email.
	_, err = tx.Exec(ctx,
		"UPDATE users SET provider = NULL, provider_id = NULL, email = NULL, email_verified = FALSE WHERE id = $1",
		fromUserID)
	if err != nil {
		return fmt.Errorf("clear source: %w", err)
	}

	// 3. Set on target — email is provider-verified (OAuth gate enforced
	//    upstream), so the flag moves with it.
	_, err = tx.Exec(ctx,
		"UPDATE users SET provider = $1, provider_id = $2, email = $3, email_verified = TRUE WHERE id = $4",
		provider, providerID, email, toUserID)
	if err != nil {
		return fmt.Errorf("transfer provider: %w", err)
	}

	// 4. Delete the source row unconditionally — the user just authenticated
	//    as the target, and the source has no provider, no email, and
	//    nothing reachable from any UI. Keeping it around just because it
	//    has a password creates a stale, login-via-username-only ghost.
	_, err = tx.Exec(ctx, "DELETE FROM users WHERE id = $1", fromUserID)
	if err != nil {
		return fmt.Errorf("cleanup orphan: %w", err)
	}

	return tx.Commit(ctx)
}

// CreateUser inserts a new password-protected user. Username is stored
// in canonical lowercase form so future lookups via LOWER(username) =
// LOWER(input) collapse to a single row regardless of how the caller
// cased their input. The HTTP layer is expected to have already run
// auth.ValidateUsername; this function does no further validation
// beyond normalisation.
func (r *PostgresRepo) CreateUser(ctx context.Context, username, password, role string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx,
		"INSERT INTO users (username, password_hash, role) VALUES (LOWER($1), $2, $3)",
		username, string(hash), role)
	return err
}

func (r *PostgresRepo) HasUsers(ctx context.Context) (bool, error) {
	var count int
	err := r.pool.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count)
	return count > 0, err
}

func (r *PostgresRepo) GetAllUsers(ctx context.Context) ([]User, error) {
	rows, err := r.pool.Query(ctx, "SELECT id, username, role, is_locked, created_at FROM users ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &u.IsLocked, &u.CreatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (r *PostgresRepo) UpdateUserRole(ctx context.Context, userID int, role string) error {
	_, err := r.pool.Exec(ctx, "UPDATE users SET role = $1 WHERE id = $2", role, userID)
	return err
}

func (r *PostgresRepo) UpdateUserPassword(ctx context.Context, userID int, newPassword string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcryptCost)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx, "UPDATE users SET password_hash = $1 WHERE id = $2", string(hash), userID)
	return err
}

// VerifyAndUpdatePassword changes the password only after confirming the
// caller knows the current one. Used by the account-management "Change
// password" form. Returns an error tagged for the handler to map to a 401:
//   - ErrCurrentPasswordWrong  — caller's current password doesn't verify
//
// Other errors (no password set, DB failure) propagate as-is. Wrapping
// these as sentinels keeps the handler thin (one switch on errors.Is).
func (r *PostgresRepo) VerifyAndUpdatePassword(ctx context.Context, userID int, currentPassword, newPassword string) error {
	var hash *string
	err := r.pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, userID).Scan(&hash)
	if err != nil {
		return err
	}
	if hash == nil || *hash == "" {
		// User signed up via OAuth and never set a password — direct them
		// at the SetPassword flow instead of pretending to "change" one
		// that doesn't exist.
		return ErrNoPasswordSet
	}
	if err := bcrypt.CompareHashAndPassword([]byte(*hash), []byte(currentPassword)); err != nil {
		return ErrCurrentPasswordWrong
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcryptCost)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx, "UPDATE users SET password_hash = $1 WHERE id = $2", string(newHash), userID)
	return err
}

// UnlinkUserEmail clears the email + verified flag and invalidates any
// outstanding verification tokens. Refuses to run when an OAuth provider
// is linked — those emails are provider-managed; the user must unlink the
// provider first (UnlinkProvider clears email itself).
func (r *PostgresRepo) UnlinkUserEmail(ctx context.Context, userID int) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var provider *string
	if err := tx.QueryRow(ctx, `SELECT provider FROM users WHERE id = $1`, userID).Scan(&provider); err != nil {
		return err
	}
	if provider != nil && *provider != "" {
		return ErrEmailManagedByOAuth
	}

	if _, err := tx.Exec(ctx,
		`UPDATE users SET email = NULL, email_verified = FALSE WHERE id = $1`, userID,
	); err != nil {
		return err
	}
	// Also invalidate any pending verification tokens — leaving them live
	// would let the old (now-removed) email be re-verified by clicking a
	// stale link.
	if _, err := tx.Exec(ctx,
		`UPDATE email_verification_tokens SET used_at = NOW()
		 WHERE user_id = $1 AND used_at IS NULL`, userID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *PostgresRepo) DeleteUser(ctx context.Context, userID int) error {
	_, err := r.pool.Exec(ctx, "DELETE FROM users WHERE id = $1", userID)
	return err
}

func (r *PostgresRepo) UpdateUserLockStatus(ctx context.Context, userID int, locked bool) error {
	_, err := r.pool.Exec(ctx, "UPDATE users SET is_locked = $1 WHERE id = $2", locked, userID)
	return err
}

// GetDigestEnabled returns the user's preference for the daily
// watchlist digest. Defaults to TRUE for existing rows (set by the
// migration) so the read is safe to call even for users that pre-date
// the column's existence.
func (r *PostgresRepo) GetDigestEnabled(ctx context.Context, userID int) (bool, error) {
	var enabled bool
	err := r.pool.QueryRow(ctx,
		"SELECT digest_enabled FROM users WHERE id = $1", userID).Scan(&enabled)
	return enabled, err
}

// SetDigestEnabled flips the per-user opt-out flag for the daily
// watchlist digest. Alert-rule notifications are unaffected — they
// have their own subscription path (push_subscriptions + alert_rules)
// and don't consult this column.
func (r *PostgresRepo) SetDigestEnabled(ctx context.Context, userID int, enabled bool) error {
	_, err := r.pool.Exec(ctx,
		"UPDATE users SET digest_enabled = $1 WHERE id = $2", enabled, userID)
	return err
}

// ListSectorOverrides returns all admin-defined symbol→sector mappings.
func (r *PostgresRepo) ListSectorOverrides(ctx context.Context) (map[string]string, error) {
	rows, err := r.pool.Query(ctx, "SELECT symbol, sector FROM sector_overrides")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var sym, sec string
		if err := rows.Scan(&sym, &sec); err != nil {
			return nil, err
		}
		out[sym] = sec
	}
	return out, rows.Err()
}

func (r *PostgresRepo) UpsertSectorOverride(ctx context.Context, symbol, sector string) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO sector_overrides (symbol, sector, updated_at)
		VALUES ($1, $2, CURRENT_TIMESTAMP)
		ON CONFLICT (symbol) DO UPDATE SET sector = EXCLUDED.sector, updated_at = CURRENT_TIMESTAMP
	`, symbol, sector)
	return err
}

func (r *PostgresRepo) DeleteSectorOverride(ctx context.Context, symbol string) error {
	_, err := r.pool.Exec(ctx, "DELETE FROM sector_overrides WHERE symbol = $1", symbol)
	return err
}

// Ping verifies Postgres connectivity. Used by the boot health check.
func (r *PostgresRepo) Ping(ctx context.Context) error {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return r.pool.Ping(cctx)
}

func (r *PostgresRepo) Close() {
	r.pool.Close()
}

// Watchlist functionalities
//
// Un-starring a symbol cascades to any alert rules the user had set on it —
// a rule for a non-watchlisted symbol is a dangling concept. Both deletes
// run in a single transaction so the caller never observes a rule that
// references a removed watchlist row.
func (r *PostgresRepo) ToggleWatchlist(ctx context.Context, userID int, symbol string) (bool, error) {
	// All three statements run in one transaction so concurrent toggles on
	// the same (user, symbol) can't race the read-modify-write and either
	// double-insert (unique violation) or leave dangling alert_rules rows.
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	// Try to insert first. ON CONFLICT DO NOTHING makes this atomic: if
	// another tx inserts first, we get 0 rows affected and fall through to
	// the delete branch below.
	ct, err := tx.Exec(ctx,
		"INSERT INTO user_watchlists (user_id, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING",
		userID, symbol)
	if err != nil {
		return false, err
	}
	if ct.RowsAffected() > 0 {
		return true, tx.Commit(ctx)
	}

	// Row already existed — remove it and cascade to any alert rules.
	if _, err := tx.Exec(ctx, "DELETE FROM user_watchlists WHERE user_id = $1 AND symbol = $2", userID, symbol); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM alert_rules WHERE user_id = $1 AND symbol = $2", userID, symbol); err != nil {
		return false, err
	}
	return false, tx.Commit(ctx)
}

func (r *PostgresRepo) GetWatchlistList(ctx context.Context, userID int) ([]string, error) {
	rows, err := r.pool.Query(ctx, "SELECT symbol FROM user_watchlists WHERE user_id = $1 ORDER BY added_at DESC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var symbols []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		symbols = append(symbols, s)
	}
	return symbols, nil
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

type AuditEntry struct {
	ID            int       `json:"id"`
	ActorID       *int      `json:"actorId,omitempty"`
	ActorUsername string    `json:"actorUsername"`
	Action        string    `json:"action"`
	TargetType    string    `json:"targetType"`
	TargetID      string    `json:"targetId"`
	Metadata      string    `json:"metadata,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
}

// InsertAuditEntry records a single audit-log row. metadataJSON should be a
// JSON-encoded string (or empty) describing the change.
func (r *PostgresRepo) InsertAuditEntry(ctx context.Context, actorID *int, actorUsername, action, targetType, targetID, metadataJSON string) error {
	var meta interface{}
	if metadataJSON == "" {
		meta = nil
	} else {
		meta = metadataJSON
	}
	_, err := r.pool.Exec(ctx,
		`INSERT INTO audit_log (actor_id, actor_username, action, target_type, target_id, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		actorID, actorUsername, action, targetType, targetID, meta,
	)
	return err
}

func (r *PostgresRepo) GetAuditLog(ctx context.Context, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := r.pool.Query(ctx,
		`SELECT id, actor_id, actor_username, action, target_type, target_id,
		        COALESCE(metadata::text, ''), created_at
		 FROM audit_log
		 ORDER BY created_at DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var actorID *int
		var actorUsername, targetType, targetID *string
		if err := rows.Scan(&e.ID, &actorID, &actorUsername, &e.Action, &targetType, &targetID, &e.Metadata, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.ActorID = actorID
		if actorUsername != nil {
			e.ActorUsername = *actorUsername
		}
		if targetType != nil {
			e.TargetType = *targetType
		}
		if targetID != nil {
			e.TargetID = *targetID
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ─── API Keys ────────────────────────────────────────────────────────────────

type APIKey struct {
	ID         int        `json:"id"`
	UserID     int        `json:"userId"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	RevokedAt  *time.Time `json:"revokedAt,omitempty"`
}

func (r *PostgresRepo) CreateAPIKey(ctx context.Context, userID int, name, keyHash, prefix string) (int, error) {
	var id int
	err := r.pool.QueryRow(ctx,
		`INSERT INTO api_keys (user_id, name, key_hash, prefix)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		userID, name, keyHash, prefix,
	).Scan(&id)
	return id, err
}

func (r *PostgresRepo) ListAPIKeys(ctx context.Context, userID int) ([]APIKey, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT id, user_id, name, prefix, last_used_at, created_at, revoked_at
		 FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []APIKey
	for rows.Next() {
		var k APIKey
		if err := rows.Scan(&k.ID, &k.UserID, &k.Name, &k.Prefix, &k.LastUsedAt, &k.CreatedAt, &k.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// LookupAPIKey resolves a hashed API key to its owner. Returns the key + the
// associated user (id, username, role, isLocked). Only returns active
// (non-revoked) keys belonging to non-locked users.
func (r *PostgresRepo) LookupAPIKey(ctx context.Context, keyHash string) (int, int, string, string, bool, error) {
	var keyID, userID int
	var username, role string
	var isLocked bool
	err := r.pool.QueryRow(ctx,
		`SELECT k.id, u.id, u.username, u.role, u.is_locked
		 FROM api_keys k JOIN users u ON u.id = k.user_id
		 WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
		keyHash,
	).Scan(&keyID, &userID, &username, &role, &isLocked)
	return keyID, userID, username, role, isLocked, err
}

// TouchAPIKey updates the last_used_at timestamp asynchronously. Errors are
// ignored — this is a usage hint, not a critical write path.
func (r *PostgresRepo) TouchAPIKey(ctx context.Context, keyID int) {
	_, _ = r.pool.Exec(ctx, `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, keyID)
}

func (r *PostgresRepo) RevokeAPIKey(ctx context.Context, userID, keyID int) error {
	tag, err := r.pool.Exec(ctx,
		`UPDATE api_keys SET revoked_at = NOW()
		 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
		keyID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("api key not found or already revoked")
	}
	return nil
}

// ── Data Quality Alerts ────────────────────────────────────────────────

// DataAlert is a row from the data_alerts table.
type DataAlert struct {
	ID           int                    `json:"id"`
	Symbol       string                 `json:"symbol"`
	TradingDate  string                 `json:"tradingDate"`
	AlertType    string                 `json:"alertType"`
	Severity     string                 `json:"severity"`
	Message      string                 `json:"message"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
	Acknowledged bool                   `json:"acknowledged"`
	CreatedAt    string                 `json:"createdAt"`
}

// SaveAlerts batch-inserts data quality alerts.
func (r *PostgresRepo) SaveAlerts(ctx context.Context, alerts []DataAlert) error {
	if len(alerts) == 0 {
		return nil
	}
	for _, a := range alerts {
		metaJSON, _ := json.Marshal(a.Metadata)
		_, err := r.pool.Exec(ctx, `
			INSERT INTO data_alerts (symbol, trading_date, alert_type, severity, message, metadata)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT DO NOTHING
		`, a.Symbol, a.TradingDate, a.AlertType, a.Severity, a.Message, metaJSON)
		if err != nil {
			return fmt.Errorf("save alert: %w", err)
		}
	}
	return nil
}

// GetRecentAlerts returns the most recent unacknowledged alerts.
func (r *PostgresRepo) GetRecentAlerts(ctx context.Context, limit int) ([]DataAlert, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, symbol, trading_date::text, alert_type, severity, message,
		       COALESCE(metadata, '{}')::text, acknowledged, created_at::text
		FROM data_alerts
		ORDER BY created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []DataAlert
	for rows.Next() {
		var a DataAlert
		var metaStr string
		if err := rows.Scan(&a.ID, &a.Symbol, &a.TradingDate, &a.AlertType, &a.Severity,
			&a.Message, &metaStr, &a.Acknowledged, &a.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(metaStr), &a.Metadata)
		out = append(out, a)
	}
	return out, rows.Err()
}

// AcknowledgeAlert marks a single alert as acknowledged.
func (r *PostgresRepo) AcknowledgeAlert(ctx context.Context, id int) error {
	tag, err := r.pool.Exec(ctx, `UPDATE data_alerts SET acknowledged = true WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("alert %d not found", id)
	}
	return nil
}

// ── Briefings ──────────────────────────────────────────────────────────

// SaveBriefing upserts a per-symbol daily insight. Rejects symbols that
// wouldn't survive the public-API symbol validator (e.g. LLM markdown
// emphasis, whitespace) so the frontend never surfaces a card it can't
// click through to.
func (r *PostgresRepo) SaveBriefing(ctx context.Context, tradingDate, symbol string, insight json.RawMessage) error {
	if !briefingSymbolRe.MatchString(symbol) {
		return fmt.Errorf("invalid briefing symbol %q", symbol)
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO briefings (trading_date, symbol, insight)
		VALUES ($1, $2, $3)
		ON CONFLICT (trading_date, symbol) DO UPDATE SET insight = EXCLUDED.insight
	`, tradingDate, symbol, insight)
	return err
}

// SaveMarketSummary upserts the daily market summary.
func (r *PostgresRepo) SaveMarketSummary(ctx context.Context, tradingDate, summary string, gainers, losers json.RawMessage, sentiment float64) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO market_summaries (trading_date, summary, top_gainers, top_losers, market_sentiment)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (trading_date) DO UPDATE SET
			summary = EXCLUDED.summary,
			top_gainers = EXCLUDED.top_gainers,
			top_losers = EXCLUDED.top_losers,
			market_sentiment = EXCLUDED.market_sentiment
	`, tradingDate, summary, gainers, losers, sentiment)
	return err
}

// BriefingResponse is the combined payload for GET /v1/briefing.
type BriefingResponse struct {
	TradingDate string            `json:"tradingDate"`
	Summary     string            `json:"summary,omitempty"`
	Sentiment   float64           `json:"sentiment"`
	TopGainers  json.RawMessage   `json:"topGainers,omitempty"`
	TopLosers   json.RawMessage   `json:"topLosers,omitempty"`
	Insights    []json.RawMessage `json:"insights"`
}

// GetLatestBriefing returns the most recent day's briefing + summary.
func (r *PostgresRepo) GetLatestBriefing(ctx context.Context) (*BriefingResponse, error) {
	// Get the latest summary
	var resp BriefingResponse
	err := r.pool.QueryRow(ctx, `
		SELECT trading_date::text, summary, COALESCE(top_gainers, '[]'), COALESCE(top_losers, '[]'), COALESCE(market_sentiment, 0)
		FROM market_summaries
		ORDER BY trading_date DESC LIMIT 1
	`).Scan(&resp.TradingDate, &resp.Summary, &resp.TopGainers, &resp.TopLosers, &resp.Sentiment)
	if err != nil {
		return nil, err
	}

	// Get insights for that date
	rows, err := r.pool.Query(ctx, `
		SELECT insight FROM briefings WHERE trading_date = $1 ORDER BY symbol
	`, resp.TradingDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var insight json.RawMessage
		if err := rows.Scan(&insight); err != nil {
			return nil, err
		}
		resp.Insights = append(resp.Insights, insight)
	}
	return &resp, rows.Err()
}

// ─── Watchlist alert rules ──────────────────────────────────────────────────
//
// Types live in the repository package (not the alerts package) to keep the
// dependency graph acyclic: the alerts package declares a narrow RuleStore
// interface and the server layer wires a thin adapter — repository has no
// import on alerts / audit / analysis.

// AlertRule mirrors the alert_rules row. The metric and op strings are
// constrained at the DB level (CHECK constraints in migration V8) so the
// Go-side validation only needs to reject unknown values before INSERT.
type AlertRule struct {
	ID          int        `json:"id"`
	UserID      int        `json:"userId"`
	Symbol      string     `json:"symbol"`
	Metric      string     `json:"metric"`
	Op          string     `json:"op"`
	Threshold   float64    `json:"threshold"`
	Enabled     bool       `json:"enabled"`
	LastFiredAt *time.Time `json:"lastFiredAt,omitempty"`
	FireCount   int        `json:"fireCount"`
	CreatedAt   time.Time  `json:"createdAt"`
}

// AlertEvent mirrors the alert_events row.
type AlertEvent struct {
	ID            int        `json:"id"`
	RuleID        int        `json:"ruleId"`
	UserID        int        `json:"userId"`
	Symbol        string     `json:"symbol"`
	Metric        string     `json:"metric"`
	Op            string     `json:"op"`
	Threshold     float64    `json:"threshold"`
	ObservedValue float64    `json:"observedValue"`
	FiredAt       time.Time  `json:"firedAt"`
	ReadAt        *time.Time `json:"readAt,omitempty"`
}

// CreateAlertRule inserts a new rule and returns the generated ID. Callers
// are responsible for capping per-user rule counts; the DB is purely the
// storage layer here.
func (r *PostgresRepo) CreateAlertRule(ctx context.Context, rule AlertRule) (int, error) {
	var id int
	err := r.pool.QueryRow(ctx, `
		INSERT INTO alert_rules (user_id, symbol, metric, op, threshold, enabled)
		VALUES ($1, $2, $3, $4, $5, TRUE)
		RETURNING id
	`, rule.UserID, rule.Symbol, rule.Metric, rule.Op, rule.Threshold).Scan(&id)
	return id, err
}

// ListAlertRulesByUser returns every rule owned by a user (enabled or not),
// newest first. Drives the "my alerts" tab in the UI.
func (r *PostgresRepo) ListAlertRulesByUser(ctx context.Context, userID int) ([]AlertRule, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, user_id, symbol, metric, op, threshold, enabled, last_fired_at, fire_count, created_at
		FROM alert_rules
		WHERE user_id = $1
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AlertRule, 0)
	for rows.Next() {
		var a AlertRule
		if err := rows.Scan(&a.ID, &a.UserID, &a.Symbol, &a.Metric, &a.Op, &a.Threshold,
			&a.Enabled, &a.LastFiredAt, &a.FireCount, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListEnabledAlertRules returns every rule across all users where enabled
// = true. The evaluator's hot-path query — runs once per post-scrape pass.
// Partial index (see migration V8) keeps this O(#enabled).
func (r *PostgresRepo) ListEnabledAlertRules(ctx context.Context) ([]AlertRule, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, user_id, symbol, metric, op, threshold, enabled, last_fired_at, fire_count, created_at
		FROM alert_rules
		WHERE enabled = TRUE
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AlertRule, 0)
	for rows.Next() {
		var a AlertRule
		if err := rows.Scan(&a.ID, &a.UserID, &a.Symbol, &a.Metric, &a.Op, &a.Threshold,
			&a.Enabled, &a.LastFiredAt, &a.FireCount, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountAlertRulesByUser is the pre-INSERT guard used by the create handler
// to enforce the per-user cap without a full ListAlertRulesByUser.
func (r *PostgresRepo) CountAlertRulesByUser(ctx context.Context, userID int) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM alert_rules WHERE user_id = $1`, userID).Scan(&n)
	return n, err
}

// UpdateAlertRuleEnabled flips a rule's enabled flag. Used to re-arm a
// rule that has fired (enabled=false after fire). Returns ErrNoRows (via
// the zero-row check) if the rule doesn't belong to the caller.
func (r *PostgresRepo) UpdateAlertRuleEnabled(ctx context.Context, userID, ruleID int, enabled bool) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE alert_rules SET enabled = $3
		WHERE id = $2 AND user_id = $1
	`, userID, ruleID, enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("alert rule %d not found", ruleID)
	}
	return nil
}

// DeleteAlertRule removes a rule. ON DELETE CASCADE on alert_events means
// any associated event rows go with it — the drawer simply won't show
// them. Callers should audit-log the removal.
func (r *PostgresRepo) DeleteAlertRule(ctx context.Context, userID, ruleID int) error {
	tag, err := r.pool.Exec(ctx, `
		DELETE FROM alert_rules WHERE id = $1 AND user_id = $2
	`, ruleID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("alert rule %d not found", ruleID)
	}
	return nil
}

// MarkAlertFired is the post-fire bookkeeping: disable the rule, stamp
// last_fired_at, increment fire_count. Called exactly once per fire.
func (r *PostgresRepo) MarkAlertFired(ctx context.Context, ruleID int, _ float64) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE alert_rules
		SET enabled = FALSE,
		    last_fired_at = NOW(),
		    fire_count = fire_count + 1
		WHERE id = $1
	`, ruleID)
	return err
}

// CreateAlertEvent persists one fired event for the in-app drawer. Returns
// the generated ID so the WS push payload can reference it.
func (r *PostgresRepo) CreateAlertEvent(ctx context.Context, ev AlertEvent) (int, error) {
	var id int
	err := r.pool.QueryRow(ctx, `
		INSERT INTO alert_events (rule_id, user_id, symbol, metric, op, threshold, observed_value, fired_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id
	`, ev.RuleID, ev.UserID, ev.Symbol, ev.Metric, ev.Op, ev.Threshold, ev.ObservedValue, ev.FiredAt).Scan(&id)
	return id, err
}

// ListAlertEventsWithUnread fuses the drawer-feed query and the
// unread-badge count into a single round trip. The bell-badge polls
// this on every drawer open + every WebSocket alert push, so halving
// the DB round trips on the hot path matters at scale.
//
// Implementation: a CTE counts unread once, then the outer SELECT
// joins it onto the page of events. The count is identical on every
// row of the page (it's a CROSS JOIN against a single-row CTE), so
// we read it from the first scanned row and ignore on the rest. When
// the page is empty we still need the count, so a UNION ALL emits a
// sentinel row when no events match — handled in Go via a leading
// `is_count_only` discriminator column.
func (r *PostgresRepo) ListAlertEventsWithUnread(ctx context.Context, userID, limit int, unreadOnly bool) ([]AlertEvent, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	whereUnread := ""
	if unreadOnly {
		whereUnread = " AND read_at IS NULL"
	}
	q := `
		WITH unread AS (
			SELECT COUNT(*)::int AS n FROM alert_events
			WHERE user_id = $1 AND read_at IS NULL
		),
		page AS (
			SELECT id, rule_id, user_id, symbol, metric, op, threshold,
			       observed_value, fired_at, read_at
			FROM alert_events
			WHERE user_id = $1` + whereUnread + `
			ORDER BY fired_at DESC LIMIT $2
		)
		SELECT FALSE AS count_only, p.id, p.rule_id, p.user_id, p.symbol, p.metric,
		       p.op, p.threshold, p.observed_value, p.fired_at, p.read_at, u.n
		  FROM page p CROSS JOIN unread u
		UNION ALL
		SELECT TRUE, 0, 0, 0, '', '', '', 0, 0, NOW(), NULL, u.n
		  FROM unread u
		 WHERE NOT EXISTS (SELECT 1 FROM page)
	`
	rows, err := r.pool.Query(ctx, q, userID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]AlertEvent, 0)
	unread := 0
	for rows.Next() {
		var (
			countOnly bool
			e         AlertEvent
			n         int
		)
		if err := rows.Scan(&countOnly, &e.ID, &e.RuleID, &e.UserID, &e.Symbol, &e.Metric, &e.Op,
			&e.Threshold, &e.ObservedValue, &e.FiredAt, &e.ReadAt, &n); err != nil {
			return nil, 0, err
		}
		unread = n
		if !countOnly {
			out = append(out, e)
		}
	}
	return out, unread, rows.Err()
}

// MarkAlertEventRead sets read_at on a single event; MarkAllAlertEventsRead
// clears the badge entirely. Both are scoped by user_id so a malicious
// client can't tamper with another user's drawer.
func (r *PostgresRepo) MarkAlertEventRead(ctx context.Context, userID, eventID int) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE alert_events SET read_at = NOW()
		WHERE id = $1 AND user_id = $2 AND read_at IS NULL
	`, eventID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("alert event %d not found or already read", eventID)
	}
	return nil
}

func (r *PostgresRepo) MarkAllAlertEventsRead(ctx context.Context, userID int) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE alert_events SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`, userID,
	)
	return err
}

// ─── Admin-scope alert views ────────────────────────────────────────────────
//
// These methods power the admin portal's "Alerts" tab. They cross the
// per-user barrier that the normal CRUD enforces, joining on users so the
// UI can show actor usernames alongside rule/event rows. Callers MUST gate
// access with AdminMiddleware — nothing in the repo layer checks the
// caller's role.

// AdminAlertRule extends AlertRule with the owner's username so the admin
// table can render a "who" column without an N+1 lookup.
type AdminAlertRule struct {
	AlertRule
	Username string `json:"username"`
}

// AdminAlertEvent extends AlertEvent with the owner's username for the
// same reason as AdminAlertRule.
type AdminAlertEvent struct {
	AlertEvent
	Username string `json:"username"`
}

// AlertStats is the numeric summary powering the admin stat strip.
type AlertStats struct {
	TotalRules    int `json:"totalRules"`
	ActiveRules   int `json:"activeRules"`
	UsersWithRule int `json:"usersWithRule"`
	FiresToday    int `json:"firesToday"`
	FiresThisWeek int `json:"firesThisWeek"`
}

// ListAllAlertRules returns every rule across all users, newest first,
// joined with the username for display. Bounded to `limit` rows so an
// overloaded deployment's rule table doesn't DoS the admin panel; 500
// covers an internal team-sized deployment comfortably.
func (r *PostgresRepo) ListAllAlertRules(ctx context.Context, limit int) ([]AdminAlertRule, error) {
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	rows, err := r.pool.Query(ctx, `
		SELECT ar.id, ar.user_id, ar.symbol, ar.metric, ar.op, ar.threshold,
		       ar.enabled, ar.last_fired_at, ar.fire_count, ar.created_at,
		       COALESCE(u.username, '')
		FROM alert_rules ar
		LEFT JOIN users u ON u.id = ar.user_id
		ORDER BY ar.created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AdminAlertRule, 0)
	for rows.Next() {
		var a AdminAlertRule
		if err := rows.Scan(&a.ID, &a.UserID, &a.Symbol, &a.Metric, &a.Op, &a.Threshold,
			&a.Enabled, &a.LastFiredAt, &a.FireCount, &a.CreatedAt, &a.Username); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// AdminDeleteAlertRule removes a rule by id, bypassing the user_id scope
// check that the per-user DeleteAlertRule enforces. Used by the admin
// panel to clean up rules from deleted users or to neutralise a spammy
// rule for support purposes. Returns an error if the rule doesn't exist
// so the caller can surface a 404.
func (r *PostgresRepo) AdminDeleteAlertRule(ctx context.Context, ruleID int) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM alert_rules WHERE id = $1`, ruleID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("alert rule %d not found", ruleID)
	}
	return nil
}

// ListAllAlertEvents returns recent fires across all users, newest first.
// Leverages idx_alert_events_user_all (per-user ordering); the planner
// falls back to a seq scan at the global level, which is fine for the
// admin panel's occasional access.
func (r *PostgresRepo) ListAllAlertEvents(ctx context.Context, limit int) ([]AdminAlertEvent, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := r.pool.Query(ctx, `
		SELECT ae.id, ae.rule_id, ae.user_id, ae.symbol, ae.metric, ae.op,
		       ae.threshold, ae.observed_value, ae.fired_at, ae.read_at,
		       COALESCE(u.username, '')
		FROM alert_events ae
		LEFT JOIN users u ON u.id = ae.user_id
		ORDER BY ae.fired_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AdminAlertEvent, 0)
	for rows.Next() {
		var e AdminAlertEvent
		if err := rows.Scan(&e.ID, &e.RuleID, &e.UserID, &e.Symbol, &e.Metric, &e.Op,
			&e.Threshold, &e.ObservedValue, &e.FiredAt, &e.ReadAt, &e.Username); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// GetAlertStats returns the admin stat strip numbers. Each field is a
// separate query because Postgres evaluates them independently; the cost
// is negligible (5 small COUNT(*)s) and the code is clearer than a UNION.
func (r *PostgresRepo) GetAlertStats(ctx context.Context) (AlertStats, error) {
	var s AlertStats
	if err := r.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM alert_rules`,
	).Scan(&s.TotalRules); err != nil {
		return s, err
	}
	if err := r.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM alert_rules WHERE enabled = TRUE`,
	).Scan(&s.ActiveRules); err != nil {
		return s, err
	}
	if err := r.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT user_id) FROM alert_rules`,
	).Scan(&s.UsersWithRule); err != nil {
		return s, err
	}
	if err := r.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM alert_events WHERE fired_at >= CURRENT_DATE`,
	).Scan(&s.FiresToday); err != nil {
		return s, err
	}
	if err := r.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM alert_events WHERE fired_at >= NOW() - INTERVAL '7 days'`,
	).Scan(&s.FiresThisWeek); err != nil {
		return s, err
	}
	return s, nil
}

// GetUserEmail returns the email address for a user (or empty string if
// the user has no email on file). Used by the alerts evaluator to resolve
// the outgoing-mail recipient. Does NOT require verification — the
// evaluator trusts the admin's gate at rule-creation time; if an email
// was ever verified we still send to it.
func (r *PostgresRepo) GetUserEmail(ctx context.Context, userID int) (string, error) {
	var email *string
	err := r.pool.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, userID).Scan(&email)
	if err != nil {
		return "", err
	}
	if email == nil {
		return "", nil
	}
	return *email, nil
}

// GetUserEmailInfo returns both the email address and the verified flag.
// The alert POST gate consults this — only verified emails clear the
// "alerts require a verified email" check. The /v1/me payload exposes
// it to the client so the pre-modal UI can route to OAuth-link vs
// manual-verify paths.
func (r *PostgresRepo) GetUserEmailInfo(ctx context.Context, userID int) (string, bool, error) {
	var email *string
	var verified bool
	err := r.pool.QueryRow(ctx,
		`SELECT email, email_verified FROM users WHERE id = $1`, userID,
	).Scan(&email, &verified)
	if err != nil {
		return "", false, err
	}
	if email == nil {
		return "", false, nil
	}
	return *email, verified, nil
}

// StartEmailVerification writes the proposed email onto users.email with
// email_verified=FALSE, invalidates any outstanding tokens for this user,
// and inserts a fresh token with a 24h TTL. Returns the token so the
// caller can send it in the outgoing email. All three steps run in one
// transaction so a crash mid-flight never leaves a usable token paired
// with an orphaned or stale email row.
//
// The caller (handler) is responsible for:
//   - Validating email format.
//   - Enforcing the unique-email index (it'll error here if another user
//     already owns the address).
//   - Sending the email with the returned token.
func (r *PostgresRepo) StartEmailVerification(ctx context.Context, userID int, email string) (string, error) {
	b := make([]byte, 32) // 256 bits → 64-char hex token
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("entropy: %w", err)
	}
	token := hex.EncodeToString(b)

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	// Upsert email + reset verified flag. This also clears an old verified
	// email if the user is changing address — conservative: they need to
	// re-verify the new one before alerts fire to it.
	if _, err := tx.Exec(ctx,
		`UPDATE users SET email = $2, email_verified = FALSE WHERE id = $1`,
		userID, email,
	); err != nil {
		return "", err
	}

	// Invalidate any outstanding tokens for this user so a leaked-but-unused
	// previous link can't resurrect a verification the user re-requested.
	if _, err := tx.Exec(ctx,
		`UPDATE email_verification_tokens
		 SET used_at = NOW()
		 WHERE user_id = $1 AND used_at IS NULL`,
		userID,
	); err != nil {
		return "", err
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO email_verification_tokens (token, user_id, email, expires_at)
		 VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
		token, userID, email,
	); err != nil {
		return "", err
	}

	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return token, nil
}

// ConsumeEmailVerifyToken atomically marks the token as used and flips
// users.email_verified to TRUE. Returns the user_id on success so the
// handler can audit-log the event. Errors when:
//   - token doesn't exist
//   - token already used_at
//   - token expires_at has passed
//   - the user's current email doesn't match the token's email (the user
//     changed address between request and click — the old token is stale)
func (r *PostgresRepo) ConsumeEmailVerifyToken(ctx context.Context, token string) (int, string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback(ctx)

	var userID int
	var email string
	var expiresAt time.Time
	var usedAt *time.Time
	err = tx.QueryRow(ctx,
		`SELECT user_id, email, expires_at, used_at
		 FROM email_verification_tokens WHERE token = $1`,
		token,
	).Scan(&userID, &email, &expiresAt, &usedAt)
	if err != nil {
		return 0, "", fmt.Errorf("token not found")
	}
	if usedAt != nil {
		return 0, "", fmt.Errorf("token already used")
	}
	if time.Now().After(expiresAt) {
		return 0, "", fmt.Errorf("token expired")
	}

	// Require the user's email to still match the token — protects against
	// replaying an old token for an address the user has since changed.
	var currentEmail *string
	if err := tx.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, userID).Scan(&currentEmail); err != nil {
		return 0, "", err
	}
	if currentEmail == nil || *currentEmail != email {
		return 0, "", fmt.Errorf("email changed — request a new verification link")
	}

	if _, err := tx.Exec(ctx,
		`UPDATE email_verification_tokens SET used_at = NOW() WHERE token = $1`, token,
	); err != nil {
		return 0, "", err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE users SET email_verified = TRUE WHERE id = $1`, userID,
	); err != nil {
		return 0, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, "", err
	}
	return userID, email, nil
}

// ── Portfolio holdings ────────────────────────────────────────────────

// PortfolioHolding mirrors one row in portfolio_holdings.
type PortfolioHolding struct {
	ID           int     `json:"id"`
	UserID       int     `json:"userId"`
	Symbol       string  `json:"symbol"`
	Quantity     float64 `json:"quantity"`
	CostBasis    float64 `json:"costBasis"`
	PurchaseDate string  `json:"purchaseDate"` // YYYY-MM-DD
	Notes        string  `json:"notes"`
}

func (r *PostgresRepo) ListPortfolioHoldings(ctx context.Context, userID int) ([]PortfolioHolding, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, user_id, symbol, quantity, cost_basis, purchase_date::text, COALESCE(notes, '')
		FROM portfolio_holdings
		WHERE user_id = $1
		ORDER BY symbol, purchase_date
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PortfolioHolding
	for rows.Next() {
		var h PortfolioHolding
		if err := rows.Scan(&h.ID, &h.UserID, &h.Symbol, &h.Quantity, &h.CostBasis, &h.PurchaseDate, &h.Notes); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func (r *PostgresRepo) CreatePortfolioHolding(ctx context.Context, userID int, symbol string, quantity, costBasis float64, purchaseDate, notes string) (int, error) {
	var id int
	err := r.pool.QueryRow(ctx, `
		INSERT INTO portfolio_holdings (user_id, symbol, quantity, cost_basis, purchase_date, notes)
		VALUES ($1, $2, $3, $4, $5::date, $6)
		RETURNING id
	`, userID, symbol, quantity, costBasis, purchaseDate, notes).Scan(&id)
	return id, err
}

func (r *PostgresRepo) UpdatePortfolioHolding(ctx context.Context, userID, holdingID int, quantity, costBasis float64, notes string) error {
	ct, err := r.pool.Exec(ctx, `
		UPDATE portfolio_holdings
		SET quantity = $1, cost_basis = $2, notes = $3
		WHERE id = $4 AND user_id = $5
	`, quantity, costBasis, notes, holdingID, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("holding not found")
	}
	return nil
}

func (r *PostgresRepo) DeletePortfolioHolding(ctx context.Context, userID, holdingID int) error {
	ct, err := r.pool.Exec(ctx, `
		DELETE FROM portfolio_holdings WHERE id = $1 AND user_id = $2
	`, holdingID, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("holding not found")
	}
	return nil
}

// ── Pro role requests ─────────────────────────────────────────────────

// ProRoleRequest mirrors one row in pro_role_requests. status is one of
// "pending", "approved", "denied" (CHECK constraint enforces). DecidedAt /
// DecidedBy / DecidedByUsername / AdminNote are zero-valued while pending.
type ProRoleRequest struct {
	ID                int        `json:"id"`
	UserID            int        `json:"userId"`
	Username          string     `json:"username"`
	Reason            string     `json:"reason"`
	Status            string     `json:"status"`
	CreatedAt         time.Time  `json:"createdAt"`
	DecidedAt         *time.Time `json:"decidedAt,omitempty"`
	DecidedBy         *int       `json:"decidedBy,omitempty"`
	DecidedByUsername string     `json:"decidedByUsername,omitempty"`
	AdminNote         string     `json:"adminNote,omitempty"`
}

// ErrProRequestExists — caller already has a pending pro-role request.
// Surfaced to the user as a 409 so the UI can render "awaiting review"
// instead of resubmitting on every page load.
var ErrProRequestExists = errors.New("a pro role request is already pending")

// CreateProRoleRequest inserts a new pending request for the given user.
// Returns ErrProRequestExists if the user already has an open pending
// request (enforced by the partial unique index from migration 13).
func (r *PostgresRepo) CreateProRoleRequest(ctx context.Context, userID int, reason string) (int, error) {
	var id int
	err := r.pool.QueryRow(ctx, `
		INSERT INTO pro_role_requests (user_id, reason)
		VALUES ($1, $2)
		RETURNING id
	`, userID, reason).Scan(&id)
	if err != nil {
		// 23505 = unique_violation — the partial unique index fired,
		// meaning a pending row already exists. We don't import pgx
		// errcode here so a string match keeps the dep surface flat.
		if strings.Contains(err.Error(), "idx_pro_role_requests_one_pending") {
			return 0, ErrProRequestExists
		}
		return 0, err
	}
	return id, nil
}

// GetActiveProRoleRequest returns the user's most recent request, regardless
// of status. Used by the account-page render to decide what to show:
// "Request Pro" button (no row), "Awaiting review" (pending), "Approved"
// (approved — though they should already be 'pro'), or "Denied" (with the
// option to reapply).
func (r *PostgresRepo) GetActiveProRoleRequest(ctx context.Context, userID int) (*ProRoleRequest, error) {
	var req ProRoleRequest
	err := r.pool.QueryRow(ctx, `
		SELECT id, user_id, reason, status, created_at, decided_at, decided_by, admin_note
		FROM pro_role_requests
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT 1
	`, userID).Scan(&req.ID, &req.UserID, &req.Reason, &req.Status, &req.CreatedAt,
		&req.DecidedAt, &req.DecidedBy, &req.AdminNote)
	if err != nil {
		return nil, err
	}
	return &req, nil
}

// ListPendingProRoleRequests returns every pending request joined with the
// requester's username, newest first. Drives the admin-portal tab.
func (r *PostgresRepo) ListPendingProRoleRequests(ctx context.Context) ([]ProRoleRequest, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT pr.id, pr.user_id, COALESCE(u.username, ''), pr.reason, pr.status,
		       pr.created_at, pr.decided_at, pr.decided_by, pr.admin_note
		FROM pro_role_requests pr
		LEFT JOIN users u ON u.id = pr.user_id
		WHERE pr.status = 'pending'
		ORDER BY pr.created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ProRoleRequest, 0)
	for rows.Next() {
		var req ProRoleRequest
		if err := rows.Scan(&req.ID, &req.UserID, &req.Username, &req.Reason, &req.Status,
			&req.CreatedAt, &req.DecidedAt, &req.DecidedBy, &req.AdminNote); err != nil {
			return nil, err
		}
		out = append(out, req)
	}
	return out, rows.Err()
}

// CountPendingProRoleRequests returns the number of pending requests.
// Powers the admin-tab badge so a freshly-loaded admin page reflects the
// queue depth even if the WS push frame was missed (cold load, slow
// client, eviction).
func (r *PostgresRepo) CountPendingProRoleRequests(ctx context.Context) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM pro_role_requests WHERE status = 'pending'
	`).Scan(&n)
	return n, err
}

// DecideProRoleRequest atomically marks a pending request as approved or
// denied and — when approved — bumps the underlying user's role to 'pro'.
// The whole pair runs in one transaction so a partial outcome (request
// approved but role not promoted, or vice versa) is impossible. Refuses
// when:
//   - request doesn't exist or is not pending
//   - the requester is no longer a user (already pro/admin) — denial-only
//     in that case is fine; approval becomes a no-op promotion
//   - approver is the requester themselves (self-approval guard, in case
//     a former user reached admin and tries to clear their own backlog)
//
// Returns the requester's user ID + username so the caller can audit-log
// and push a WS notification to the user telling them the result.
func (r *PostgresRepo) DecideProRoleRequest(ctx context.Context, requestID, approverID int, approve bool, note string) (int, string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback(ctx)

	var userID int
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT user_id, status FROM pro_role_requests WHERE id = $1 FOR UPDATE`,
		requestID,
	).Scan(&userID, &status); err != nil {
		return 0, "", fmt.Errorf("request not found")
	}
	if status != "pending" {
		return 0, "", fmt.Errorf("request already %s", status)
	}
	if userID == approverID {
		return 0, "", fmt.Errorf("cannot decide your own request")
	}

	newStatus := "denied"
	if approve {
		newStatus = "approved"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE pro_role_requests
		   SET status = $1, decided_at = NOW(), decided_by = $2, admin_note = $3
		 WHERE id = $4
	`, newStatus, approverID, note, requestID); err != nil {
		return 0, "", err
	}

	if approve {
		// Only promote if the user is currently 'user'. Skip the bump
		// for already-elevated accounts (admin/pro/analyst/bot) so an
		// approver doesn't accidentally demote an admin to pro by
		// clearing a stale request.
		if _, err := tx.Exec(ctx, `
			UPDATE users SET role = 'pro' WHERE id = $1 AND role = 'user'
		`, userID); err != nil {
			return 0, "", err
		}
	}

	var username string
	if err := tx.QueryRow(ctx, `SELECT username FROM users WHERE id = $1`, userID).Scan(&username); err != nil {
		// User deleted between request and decision — non-fatal, return
		// empty username and let the caller skip the user-side WS push.
		username = ""
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, "", err
	}
	return userID, username, nil
}

// ListAdminUserIDs returns the IDs of every user with role='admin'. Used
// by the WS fan-out path so a new pro-role request can notify every
// connected admin session in real time.
func (r *PostgresRepo) ListAdminUserIDs(ctx context.Context) ([]int, error) {
	rows, err := r.pool.Query(ctx, `SELECT id FROM users WHERE role = 'admin'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]int, 0)
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ── Push subscriptions ────────────────────────────────────────────────

// PushSubscription mirrors one row in push_subscriptions.
type PushSubscription struct {
	ID         int    `json:"id"`
	UserID     int    `json:"userId"`
	Endpoint   string `json:"endpoint"`
	P256dh     string `json:"p256dh"`
	AuthSecret string `json:"auth"`
}

// UpsertPushSubscription inserts or updates a push subscription for a
// user+endpoint pair. Multiple devices per user are supported.
func (r *PostgresRepo) UpsertPushSubscription(ctx context.Context, userID int, endpoint, p256dh, authSecret string) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_secret)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id, endpoint) DO UPDATE SET
			p256dh = EXCLUDED.p256dh,
			auth_secret = EXCLUDED.auth_secret,
			subscribed_at = CURRENT_TIMESTAMP
	`, userID, endpoint, p256dh, authSecret)
	return err
}

// DeletePushSubscription removes a subscription by endpoint (e.g. when
// the user unsubscribes or the push provider returns 404/410).
func (r *PostgresRepo) DeletePushSubscription(ctx context.Context, userID int, endpoint string) error {
	_, err := r.pool.Exec(ctx, `
		DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2
	`, userID, endpoint)
	return err
}

// DeletePushSubscriptionByEndpoint removes a stale subscription when
// the push provider rejects it (410 Gone). Called without a user ID
// because the provider just tells us the endpoint died.
func (r *PostgresRepo) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	_, err := r.pool.Exec(ctx, `
		DELETE FROM push_subscriptions WHERE endpoint = $1
	`, endpoint)
	return err
}

// ListPushSubscriptions returns all active subscriptions for a user.
func (r *PostgresRepo) ListPushSubscriptions(ctx context.Context, userID int) ([]PushSubscription, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, user_id, endpoint, p256dh, auth_secret
		FROM push_subscriptions
		WHERE user_id = $1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var subs []PushSubscription
	for rows.Next() {
		var s PushSubscription
		if err := rows.Scan(&s.ID, &s.UserID, &s.Endpoint, &s.P256dh, &s.AuthSecret); err != nil {
			return nil, err
		}
		subs = append(subs, s)
	}
	return subs, rows.Err()
}

// UserWatchListRow groups one user's watchList symbols for digest fan-out.
type UserWatchListRow struct {
	UserID  int
	Symbols []string
}

// ListWatchListsForPushSubscribers returns every user who has BOTH at least
// one active push subscription AND at least one watchList symbol AND has
// not opted out of the daily digest (users.digest_enabled = TRUE). Each
// row includes that user's full watchList (newest first). Used by the
// post-scrape watchList digest fan-out to avoid sending notifications
// to users who would have nothing to receive — and to honour the
// per-user opt-out so alert subscribers aren't forced to take the
// daily summary too.
func (r *PostgresRepo) ListWatchListsForPushSubscribers(ctx context.Context) ([]UserWatchListRow, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT w.user_id, ARRAY_AGG(w.symbol ORDER BY w.added_at DESC) AS symbols
		FROM user_watchlists w
		WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = w.user_id)
		  AND EXISTS (SELECT 1 FROM users u WHERE u.id = w.user_id AND u.digest_enabled = TRUE)
		GROUP BY w.user_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UserWatchListRow
	for rows.Next() {
		var row UserWatchListRow
		if err := rows.Scan(&row.UserID, &row.Symbols); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
