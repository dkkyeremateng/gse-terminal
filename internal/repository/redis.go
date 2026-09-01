package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

type RedisRepo struct {
	client *redis.Client
}

func NewRedisRepo(addr string) *RedisRepo {
	// Pool + timeout tuning. Defaults have no read/write deadlines and
	// unbounded retries, which under Redis flake turns a single slow
	// request into a cascading request-thread starve. Explicit values:
	//   - DialTimeout: cap connection establishment
	//   - Read/WriteTimeout: per-op socket deadline
	//   - PoolSize: max concurrent connections (≥ typical handler fanout)
	//   - MinIdleConns: keep a warm set so first-after-quiet isn't cold
	//   - MaxRetries: bounded — one retry on transient network errors
	rdb := redis.NewClient(&redis.Options{
		Addr:            addr,
		DialTimeout:     2 * time.Second,
		ReadTimeout:     3 * time.Second,
		WriteTimeout:    3 * time.Second,
		PoolSize:        20,
		MinIdleConns:    2,
		MaxRetries:      1,
		MinRetryBackoff: 100 * time.Millisecond,
		MaxRetryBackoff: 500 * time.Millisecond,
	})
	return &RedisRepo{client: rdb}
}

func (r *RedisRepo) Set(ctx context.Context, key string, value []byte) error {
	return r.client.Set(ctx, key, value, 5*time.Minute).Err()
}

func (r *RedisRepo) SetWithTTL(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return r.client.Set(ctx, key, value, ttl).Err()
}

func (r *RedisRepo) Get(ctx context.Context, key string) ([]byte, error) {
	return r.client.Get(ctx, key).Bytes()
}

func (r *RedisRepo) Close() error {
	return r.client.Close()
}

func (r *RedisRepo) FlushAll(ctx context.Context) error {
	return r.client.FlushAll(ctx).Err()
}

// Ping verifies Redis connectivity. Used by the boot health check so a
// misconfigured deployment fails fast instead of throwing 500s on the
// first cache lookup.
func (r *RedisRepo) Ping(ctx context.Context) error {
	return r.client.Ping(ctx).Err()
}

// Revoke records a JWT jti as no-longer-valid. The TTL should match the
// remaining lifetime of the token so the entry self-expires once the
// underlying JWT would have expired anyway. Cheap and bounded.
func (r *RedisRepo) Revoke(ctx context.Context, jti string, ttl time.Duration) error {
	if ttl <= 0 {
		return nil
	}
	return r.client.Set(ctx, "auth:revoked:"+jti, "1", ttl).Err()
}

// IsRevoked is the hot-path lookup used by Middleware on every request
// that presents a JWT. Returns false on Redis errors so a temporary outage
// doesn't lock everyone out.
func (r *RedisRepo) IsRevoked(ctx context.Context, jti string) (bool, error) {
	n, err := r.client.Exists(ctx, "auth:revoked:"+jti).Result()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ── Refresh tokens ────────────────────────────────────────────────────

// refreshKey is the Redis key format for opaque refresh tokens. The
// token value itself is high-entropy, so using it directly as the key
// (rather than hashing) is fine — an attacker with Redis read access
// already has every secret in the system.
func refreshKey(token string) string { return "auth:refresh:" + token }

// refreshValue is the Redis-stored refresh-token payload. Includes
// username + role so silent refresh can rebuild the session from the
// cached value without a DB round-trip. Short JSON field names keep
// the Redis footprint tight; 90d × active users × overhead adds up.
type refreshValue struct {
	UserID   int    `json:"uid"`
	Username string `json:"u"`
	Role     string `json:"r"`
	// Epoch is the session epoch current when this token was issued.
	// silentRefresh refuses the token when it no longer matches, which
	// is how a role change or a deletion invalidates a refresh cookie
	// that would otherwise keep minting fresh access JWTs for 90 days.
	Epoch int `json:"e"`
}

// StoreRefreshToken writes the token → (userID, username, role) record
// with a TTL matching the cookie's MaxAge. Identity is stashed alongside
// the user id so silent refresh never touches Postgres.
func (r *RedisRepo) StoreRefreshToken(ctx context.Context, token string, userID int, username, role string, epoch int, ttl time.Duration) error {
	if ttl <= 0 {
		return errors.New("refresh ttl must be positive")
	}
	payload, err := json.Marshal(refreshValue{UserID: userID, Username: username, Role: role, Epoch: epoch})
	if err != nil {
		return err
	}
	return r.client.Set(ctx, refreshKey(token), payload, ttl).Err()
}

// LookupRefreshToken returns the identity bound to the refresh token
// or an error when the token is unknown / expired / malformed.
//
// Legacy values from the pre-identity-stash format (plain decimal user
// ids) are still decoded — userID is populated, username/role are
// empty. The auth middleware treats those as force-re-login so the
// next logged-in session transparently upgrades to the new format.
func (r *RedisRepo) LookupRefreshToken(ctx context.Context, token string) (int, string, string, int, error) {
	val, err := r.client.Get(ctx, refreshKey(token)).Bytes()
	if err != nil {
		return 0, "", "", 0, err
	}
	var v refreshValue
	if jsonErr := json.Unmarshal(val, &v); jsonErr == nil && v.UserID > 0 {
		// Tokens written before the epoch field existed decode with
		// Epoch 0, which matches an unbumped user — correct, and they
		// are re-stamped on the owner's next login.
		return v.UserID, v.Username, v.Role, v.Epoch, nil
	}
	// Legacy plain-int format — caller will treat empty identity as
	// a signal to force re-auth.
	if id, convErr := strconv.Atoi(string(val)); convErr == nil {
		return id, "", "", 0, nil
	}
	return 0, "", "", 0, errors.New("malformed refresh token value")
}

// TouchRefreshToken extends the token's TTL without changing its
// value — sliding expiry. Called on every successful silent refresh
// so active users never get kicked out.
func (r *RedisRepo) TouchRefreshToken(ctx context.Context, token string, ttl time.Duration) error {
	if ttl <= 0 {
		return errors.New("refresh ttl must be positive")
	}
	return r.client.Expire(ctx, refreshKey(token), ttl).Err()
}

// DeleteRefreshToken invalidates a refresh token immediately. Called
// by /logout and by the middleware when a refresh lookup reveals the
// account has been locked mid-session.
func (r *RedisRepo) DeleteRefreshToken(ctx context.Context, token string) error {
	return r.client.Del(ctx, refreshKey(token)).Err()
}

// userLockedKey is the Redis sentinel key indicating an admin has
// locked a specific user mid-session. Setting this key blocks the
// silent-refresh path (auth.silentRefresh) from issuing a new access
// JWT for any of the user's outstanding refresh tokens — closing the
// loop where a locked user could otherwise stay signed in for up to
// RefreshTokenTTL (90d) just by visiting the site once and triggering
// silent refresh against their unrevoked refresh cookie.
//
// We keep refresh tokens themselves intact (no per-user index needed
// to enumerate them) — the sentinel makes them all unusable in one
// write, and they age out naturally via their own TTLs.
func userLockedKey(userID int) string {
	return "auth:user_locked:" + strconv.Itoa(userID)
}

// MarkUserLocked sets the lock sentinel for `userID` with a TTL that
// outlives any possible refresh token (cap at RefreshTokenTTL from
// auth.RefreshTokenTTL). After this returns, every silent-refresh
// attempt for the user fails until ClearUserLock is called or the TTL
// expires.
func (r *RedisRepo) MarkUserLocked(ctx context.Context, userID int, ttl time.Duration) error {
	if ttl <= 0 {
		return errors.New("lock ttl must be positive")
	}
	return r.client.Set(ctx, userLockedKey(userID), "1", ttl).Err()
}

// ClearUserLock removes the lock sentinel so silent-refresh resumes
// working on the user's existing refresh tokens. Called when an admin
// unlocks the account.
func (r *RedisRepo) ClearUserLock(ctx context.Context, userID int) error {
	return r.client.Del(ctx, userLockedKey(userID)).Err()
}

// IsUserLocked is the hot-path check used by silent refresh. Soft-fail
// on Redis errors (returns false) so a transient outage doesn't kick
// every active user out — admin-initiated locks are durable in Postgres
// and any Redis-blip window closes once the cache recovers.
func (r *RedisRepo) IsUserLocked(ctx context.Context, userID int) (bool, error) {
	n, err := r.client.Exists(ctx, userLockedKey(userID)).Result()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ── Session epoch ─────────────────────────────────────────────────────

// sessionEpochKey holds a monotonically increasing counter per user.
// Every credential we mint — the access JWT (as the `sess` claim) and
// the refresh-token record — carries the epoch that was current when
// it was issued. Anything presenting a stale epoch is refused.
//
// This is what makes privilege revocation actually take effect. The
// lock sentinel above can only block the silent-refresh path, so a
// locked user keeps their current access JWT until it expires. The
// epoch is checked on EVERY authenticated request, so bumping it
// invalidates outstanding access tokens as well — which is what a
// role demotion or an account deletion needs.
//
// Deliberately persistent (no TTL). If the key expired, every session
// issued under a non-zero epoch would read the current epoch back as
// 0, mismatch, and force a re-login. The keyspace is bounded by the
// number of users who have ever been demoted, locked, or deleted —
// a handful of integers, not something worth expiring.
func sessionEpochKey(userID int) string {
	return "auth:session_epoch:" + strconv.Itoa(userID)
}

// BumpSessionEpoch invalidates every outstanding session for userID —
// access JWTs and refresh tokens alike — and returns the new epoch.
// Call it from any path that changes what a session is allowed to do:
// role change, lock, delete.
func (r *RedisRepo) BumpSessionEpoch(ctx context.Context, userID int) (int, error) {
	n, err := r.client.Incr(ctx, sessionEpochKey(userID)).Result()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// SessionEpoch returns the current epoch for userID, or 0 when the user
// has never had one bumped. Read at login so the issued credentials are
// stamped with it.
//
// Soft-fails to 0 on a Redis error rather than propagating: a blip at
// login time should not block the login. The worst case is a session
// stamped with epoch 0 that gets refused on its first request once
// Redis recovers — annoying, not insecure.
func (r *RedisRepo) SessionEpoch(ctx context.Context, userID int) (int, error) {
	n, err := r.client.Get(ctx, sessionEpochKey(userID)).Int()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return n, nil
}

// CheckSession answers both hot-path session questions in a single
// round trip: is this jti revoked, and what is the user's current
// epoch. The auth middleware runs this on every authenticated request,
// so folding the two lookups into one pipeline keeps the added epoch
// check off the latency budget — it costs no extra RTT over the
// revocation lookup that was already there.
func (r *RedisRepo) CheckSession(ctx context.Context, jti string, userID int) (bool, int, error) {
	pipe := r.client.Pipeline()
	revoked := pipe.Exists(ctx, "auth:revoked:"+jti)
	epoch := pipe.Get(ctx, sessionEpochKey(userID))
	// Exec reports redis.Nil when any command in the pipeline returned a
	// nil reply. That is the normal case here (an unbumped user has no
	// epoch key), so it is not an error — the per-command results below
	// are still populated.
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return false, 0, err
	}
	n, err := epoch.Int()
	if err == redis.Nil {
		n = 0
	} else if err != nil {
		return false, 0, err
	}
	return revoked.Val() > 0, n, nil
}

// MarkDigestSent records that a daily watchlist digest has been
// dispatched for `userID` on `day` (YYYY-MM-DD UTC). Returns true
// when the entry is newly written (caller should proceed with the
// push), false when an entry already exists for that pair (caller
// should skip).
//
// Used by push.Service.SendWatchListDigest to gate the post-upload
// + post-scrape paths so each user receives at most one digest per
// trading day even when both fire. Implemented as a single atomic
// SETNX with a ~30h TTL — long enough to span all reasonable trigger
// windows for one trading day, short enough that the keyspace
// doesn't grow unbounded.
func (r *RedisRepo) MarkDigestSent(ctx context.Context, userID int, day string) (bool, error) {
	key := "digest:sent:" + day + ":" + strconv.Itoa(userID)
	return r.client.SetNX(ctx, key, "1", 30*time.Hour).Result()
}

// Delete removes one or more keys outright. Wraps redis DEL for callers
// that know the exact key(s) they want gone — cheaper than the SCAN+DEL
// walk in InvalidatePattern when there's no wildcard to expand.
func (r *RedisRepo) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	return r.client.Del(ctx, keys...).Err()
}

// InvalidatePattern deletes every key matching `pattern` (e.g.
// "gse:history:*"). Uses SCAN+DEL for safety on large keyspaces — does not
// block the Redis server like KEYS would.
func (r *RedisRepo) InvalidatePattern(ctx context.Context, pattern string) error {
	iter := r.client.Scan(ctx, 0, pattern, 100).Iterator()
	for iter.Next(ctx) {
		if err := r.client.Del(ctx, iter.Val()).Err(); err != nil {
			return err
		}
	}
	return iter.Err()
}
