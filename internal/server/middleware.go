package server

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5/middleware"
)

// LoggerFromCtx returns a slog logger pre-bound with the chi request ID so any
// log line written from a handler can be correlated end-to-end.
func LoggerFromCtx(ctx context.Context) *slog.Logger {
	if id := middleware.GetReqID(ctx); id != "" {
		return slog.With("request_id", id)
	}
	return slog.Default()
}

// RequestIDHeader exposes the request ID on the response so clients can quote
// it when reporting issues.
func RequestIDHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := middleware.GetReqID(r.Context()); id != "" {
			w.Header().Set("X-Request-ID", id)
		}
		next.ServeHTTP(w, r)
	})
}
