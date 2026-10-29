package main

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// questDBConnectWindow bounds how long boot waits for QuestDB. After a host
// reboot QuestDB needs a few seconds to open its ILP listener; a minute is
// ample for that and still short enough that a genuinely absent database
// fails the boot visibly instead of hanging it.
const questDBConnectWindow = 60 * time.Second

// connectBackoff is the delay schedule between attempts: starts short so the
// common case (dependency up a second later) costs almost nothing, and caps
// so a long outage isn't hammered.
var connectBackoff = struct{ initial, max time.Duration }{time.Second, 5 * time.Second}

// connectWithRetry calls connect until it succeeds or window elapses, and
// returns the last error if it never does. Each attempt gets the remaining
// window as its deadline, so one hung dial can't outlive the whole budget.
func connectWithRetry[T any](ctx context.Context, name string, window time.Duration, connect func(context.Context) (T, error)) (T, error) {
	ctx, cancel := context.WithTimeout(ctx, window)
	defer cancel()

	delay := connectBackoff.initial
	for attempt := 1; ; attempt++ {
		v, err := connect(ctx)
		if err == nil {
			if attempt > 1 {
				slog.Info("Connected after retry", "dependency", name, "attempts", attempt)
			}
			return v, nil
		}
		slog.Warn("Dependency not ready, retrying", "dependency", name, "attempt", attempt, "retry_in", delay, "error", err)

		select {
		case <-ctx.Done():
			var zero T
			return zero, fmt.Errorf("%s unavailable after %d attempts in %v: %w", name, attempt, window, err)
		case <-time.After(delay):
		}
		delay = min(delay*2, connectBackoff.max)
	}
}
