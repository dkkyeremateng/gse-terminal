package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/metrics"
)

// dataCacheTTL is the TTL applied to every cached DB read. Data changes
// at the daily upload boundary (or nightly scrape) and both paths
// explicitly invalidate the cache, so the TTL is a safety net rather
// than the freshness primitive. Capped at a few hours so a missed
// invalidation (Redis blip during InvalidatePattern, scraper hook
// failure, schema-drift edge case) self-heals within one trading
// session instead of pinning a week of stale derived data on every
// connected client.
const dataCacheTTL = 6 * time.Hour

// isEmptyJSON reports whether `b` is a structurally empty JSON payload
// — null, [], {}, or "" — that we should NOT cache because doing so
// would mask freshly-uploaded data for the entire TTL. The previous
// implementation only checked the literal strings "null" and "[]";
// this version normalises whitespace and matches one extra shape ({}).
// Deeper structural emptiness (e.g. {"items":[]}) is intentionally
// out of scope: the fetch functions either return nil/[] for empty
// data (which we catch here) or return a populated wrapper, in which
// case caching is the right call.
func isEmptyJSON(b []byte) bool {
	s := strings.TrimSpace(string(b))
	switch s {
	case "", "null", "[]", "{}", `""`:
		return true
	}
	return false
}

// cachedJSONBytes returns the cached JSON for `key` if present, otherwise
// it invokes `fetch`, JSON-encodes the result, writes it to the cache with
// the long-lived data TTL, and returns the bytes. Cache write is detached
// from the request lifecycle so a slow Redis can't slow down the response.
func (s *Server) cachedJSONBytes(ctx context.Context, key string, fetch func() (interface{}, error)) ([]byte, error) {
	return s.cachedJSONBytesTTL(ctx, key, dataCacheTTL, fetch)
}

// cachedJSONBytesTTL is the TTL-parameterised variant. Use it when a
// particular payload needs a different freshness window than the default
// `dataCacheTTL` — e.g. LLM-generated AI insights cache for ~12h under
// a non-`gse:data:*` prefix so the scrape invalidation pattern doesn't
// wipe them every day and force a Gemini re-fetch burst.
func (s *Server) cachedJSONBytesTTL(ctx context.Context, key string, ttl time.Duration, fetch func() (interface{}, error)) ([]byte, error) {
	if cached, err := s.redisRepo.Get(ctx, key); err == nil && len(cached) > 0 {
		// Skip stale empty cached values — treat them as a cache miss
		// so we re-query the DB (which may now have data after an upload).
		if !isEmptyJSON(cached) {
			metrics.CacheHits.WithLabelValues("redis").Inc()
			return cached, nil
		}
	}
	metrics.CacheMisses.WithLabelValues("redis").Inc()

	value, err := fetch()
	if err != nil {
		return nil, err
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}

	// Never cache structurally empty results — they'd mask data that
	// arrives later (e.g. after an upload) for the entire TTL.
	// Routed through goBackground so Shutdown() can join the writes
	// before tearing down the Redis client connection pool.
	if !isEmptyJSON(bytes) {
		b := bytes
		writeTTL := ttl
		s.goBackground(func(bgCtx context.Context) {
			writeCtx, cancel := context.WithTimeout(bgCtx, 5*time.Second)
			defer cancel()
			_ = s.redisRepo.SetWithTTL(writeCtx, key, b, writeTTL)
		})
	}

	return bytes, nil
}

// writeCachedJSON serves the bytes returned by cachedJSONBytes with the
// correct Content-Type, used by handlers that just want to forward the
// cached payload directly to the client.
func writeCachedJSON(w http.ResponseWriter, bytes []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(bytes)
}
