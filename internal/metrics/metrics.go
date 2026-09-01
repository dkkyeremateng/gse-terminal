// Package metrics exposes a small set of Prometheus collectors and a chi
// middleware so operators can scrape /metrics for handler latency, cache
// hit/miss ratios, and the live WebSocket connection count. Kept
// deliberately small — four collectors, no process-specific custom metrics —
// so the /metrics payload stays cheap to scrape.
//
// All collectors register against prometheus.DefaultRegisterer so the stock
// promhttp.Handler() at /metrics picks them up alongside the Go runtime
// collectors (goroutines, GC, heap) registered by client_golang on init.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// HTTPRequestsTotal counts every request by matched chi route pattern,
	// method, and status family. Using the route pattern (not the raw URL)
	// keeps cardinality bounded — `/v1/history` stays one series instead
	// of one per symbol.
	HTTPRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests handled, labelled by method, matched route pattern, and status code.",
		},
		[]string{"method", "route", "status"},
	)

	// HTTPRequestDuration tracks end-to-end handler latency. Buckets span
	// the realistic range for this service — sub-ms cached reads up to
	// multi-second LLM endpoints — without over-sampling either tail.
	HTTPRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "Latency of HTTP requests in seconds, labelled by method and matched route pattern.",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
		},
		[]string{"method", "route"},
	)

	// CacheHits / CacheMisses count lookups against the Redis JSON cache
	// layer in internal/server/cache.go. Operators read the ratio to
	// judge whether the 7-day TTL is tuned low or whether upstream
	// invalidations are firing more than expected.
	CacheHits = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cache_hits_total",
			Help: "Number of Redis cache hits, labelled by cache name.",
		},
		[]string{"cache"},
	)
	CacheMisses = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cache_misses_total",
			Help: "Number of Redis cache misses, labelled by cache name.",
		},
		[]string{"cache"},
	)

	// WebSocketConnections tracks the live WebSocket connection count.
	// Gauge rather than counter — we care about the current value, not
	// the sum of admissions. Incremented on Hub.register, decremented on
	// Hub.unregister.
	WebSocketConnections = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "websocket_connections_active",
			Help: "Current number of active WebSocket client connections registered on the hub.",
		},
	)
)

// InstrumentHTTP wraps a chi handler so every request records its status,
// method, matched route pattern, and duration. Placed AFTER chi's
// RequestID + Logger middleware so the route pattern is populated by the
// time the deferred observation runs, and BEFORE rate limiters so they're
// visible as 429s rather than silently dropped at the edge.
func InstrumentHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /metrics itself shouldn't count against /metrics — it'd create
		// a self-referential series that grows with scrape interval.
		if r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)

		route := chi.RouteContext(r.Context()).RoutePattern()
		if route == "" {
			// Unmatched routes (404s, static file fallbacks) collapse
			// to a single series so a scanner hitting /wp-admin etc.
			// can't explode label cardinality.
			route = "unmatched"
		}
		HTTPRequestsTotal.WithLabelValues(r.Method, route, strconv.Itoa(ww.Status())).Inc()
		HTTPRequestDuration.WithLabelValues(r.Method, route).Observe(time.Since(start).Seconds())
	})
}
