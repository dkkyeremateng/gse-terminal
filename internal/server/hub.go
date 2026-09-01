package server

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/teckdroids/ges-data-engine/internal/metrics"
)

// WebSocket hardening constants. These cap resource usage per-client
// and time out silent peers so a stalled mobile tab can't leak a
// goroutine + socket pair indefinitely.
const (
	// Max inbound frame size. The client only sends heartbeats / closes
	// — it never posts data — so a tight cap is fine.
	wsMaxMessageSize = 1 << 16 // 64 KiB

	// Hard deadline on each write. If a client's TCP window stays full
	// past this, we consider it hung and close.
	wsWriteWait = 10 * time.Second

	// Expect a pong (or any frame) within this interval. Must be strictly
	// greater than wsPingPeriod so we always get at least one ping's
	// worth of slack before we consider the connection dead.
	wsPongWait = 60 * time.Second

	// Send pings slightly faster than wsPongWait so the deadline-extend
	// path stays ahead of the deadline itself.
	wsPingPeriod = (wsPongWait * 9) / 10 // 54s

	// Hard cap on concurrent clients. A flood of idle / unauthenticated
	// connections would otherwise grow h.clients without bound and
	// exhaust the heap. At ~10 KiB of send buffer + goroutine stacks per
	// client, 10k clients is roughly 100 MiB — well within pod memory,
	// but we should refuse further registrations instead of crashing.
	wsMaxClients = 10000
)

// Hub maintains the set of active clients and broadcasts messages to the clients.
type Hub struct {
	// Registered clients.
	clients map[*Client]bool

	// Inbound messages from the collectors.
	Broadcast chan []byte

	// Register requests from the clients.
	register chan *Client

	// Unregister requests from clients.
	unregister chan *Client

	mu sync.RWMutex
}

func NewHub() *Hub {
	// unregister is buffered because the broadcast path evicts slow
	// clients by writing to it — and Run is the sole reader. An unbuffered
	// channel self-deadlocks the first time a slow client trips the
	// eviction branch: the broadcast loop writes, no reader, Run never
	// returns to select. 64 slots absorb bursts (mass disconnect on
	// deploy, backpressure spike) without bounding us to the goroutine
	// workaround.
	// Broadcast buffer sized to absorb a nightly-scrape ingestion frame
	// landing at the same moment as a cache:bust (see broadcastCacheBust)
	// and any live ticks queued behind them. At 16 slots the cache:bust
	// got dropped under load — with 128 the marginal cost is trivial
	// (~16 KiB of []byte slots at most) but a missed bust now requires
	// a genuine pathological traffic pattern, not routine coincidence.
	return &Hub{
		Broadcast:  make(chan []byte, 128),
		register:   make(chan *Client, 16),
		unregister: make(chan *Client, 64),
		clients:    make(map[*Client]bool),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			if len(h.clients) >= wsMaxClients {
				h.mu.Unlock()
				slog.Warn("WebSocket client cap reached; rejecting new connection",
					"addr", client.conn.RemoteAddr(), "cap", wsMaxClients)
				// Closing the send channel causes WritePump to emit a close
				// frame and exit; HandleWS's defer will then land in
				// unregister, which no-ops because we never added the client
				// to the map.
				close(client.send)
				continue
			}
			h.clients[client] = true
			metrics.WebSocketConnections.Inc()
			h.mu.Unlock()
			slog.Debug("WebSocket client registered", "addr", client.conn.RemoteAddr())

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
				metrics.WebSocketConnections.Dec()
			}
			h.mu.Unlock()
			slog.Debug("WebSocket client unregistered", "addr", client.conn.RemoteAddr())

		case message := <-h.Broadcast:
			// Snapshot the client set under read lock, then send without
			// holding the lock to avoid blocking register/unregister while a
			// slow client times out. Slow clients are evicted via the
			// unregister channel so cleanup happens in one place.
			h.mu.RLock()
			clients := make([]*Client, 0, len(h.clients))
			for c := range h.clients {
				clients = append(clients, c)
			}
			h.mu.RUnlock()

			for _, client := range clients {
				select {
				case client.send <- message:
				default:
					// Buffer is full — client can't keep up. Try to expedite
					// eviction via the unregister channel, but never block:
					// Run is the sole reader of unregister, so a blocking send
					// from inside this loop self-deadlocks the hub if more
					// than cap(unregister) clients stall on the same frame.
					// If the hint can't be enqueued the client still gets
					// cleaned up shortly via WritePump's wsWriteWait deadline
					// → conn close → HandleWS defer → unregister.
					select {
					case h.unregister <- client:
						slog.Warn("Evicting slow WebSocket client", "addr", client.conn.RemoteAddr())
					default:
						slog.Warn("Slow WebSocket client; eviction hint dropped (unregister full)",
							"addr", client.conn.RemoteAddr())
					}
				}
			}
		}
	}
}

// broadcastCacheBust tells every connected client to drop its in-memory
// GET caches (history, insight, briefing, symbols). Fired after an
// admin CSV upload or a nightly scrape so tabs loaded before the refresh
// don't keep serving stale derived data until their per-key TTL expires.
//
// Cache-bust frames are rare (a handful per day) but high-impact: a
// dropped frame leaves every connected client serving stale derived
// data until per-key TTL expires (up to dataCacheTTL). Tick frames, by
// contrast, are common and fungible — the next tick supersedes a
// missed one. So this enqueue retries with backoff instead of dropping
// after the first failed enqueue. Bounded: if the buffer stays full
// for the entire window we give up and log loudly so monitoring can
// surface a stuck Run loop. Runs in a goroutine so the upload handler
// returns promptly even when the buffer is briefly saturated.
var cacheBustFrame = []byte(`{"type":"cache:bust"}`)

// broadcastCacheBust is a method on *Server (not a free function) so the
// retry goroutine spawned on a saturated Broadcast buffer can be tracked
// via s.goBackground — meaning Shutdown waits for in-flight retries to
// drain instead of orphaning them. The retry honours s.bgCtx, so a
// shutdown that races a stuck buffer terminates the loop promptly
// (ctx.Done fires) instead of sleeping out the remaining backoff.
func (s *Server) broadcastCacheBust() {
	if s == nil || s.Hub == nil {
		return
	}
	// Fast path — buffer has room, enqueue immediately.
	select {
	case s.Hub.Broadcast <- cacheBustFrame:
		return
	default:
	}
	// Slow path — retry with exponential backoff up to ~3.1s total.
	// Tracked via goBackground so Shutdown drains correctly; honours
	// bgCtx so a shutdown mid-backoff terminates the loop.
	s.goBackground(func(bgCtx context.Context) {
		delay := 50 * time.Millisecond
		for i := 0; i < 7; i++ {
			select {
			case <-bgCtx.Done():
				return
			case <-time.After(delay):
			}
			select {
			case s.Hub.Broadcast <- cacheBustFrame:
				slog.Info("cache:bust enqueued after retry", "attempts", i+2)
				return
			default:
				delay *= 2
			}
		}
		slog.Error("cache:bust dropped after retries — Broadcast buffer stuck full; clients will see stale data until per-key TTL")
	})
}

// PushToRole delivers a message to every connected client whose
// authenticated session matches the given role. Used for fan-out
// notifications targeted at a class of users (admins receiving pro-role
// requests, future analyst-only broadcasts) without an N×PushToUser
// loop. Returns the number of clients the message was dispatched to;
// slow clients drop the frame (same policy as Broadcast / PushToUser).
func (h *Hub) PushToRole(role string, message []byte) int {
	if role == "" || len(message) == 0 {
		return 0
	}
	// Snapshot the matching clients under RLock, then drop the lock
	// before sending. Holding the read lock across channel sends would
	// queue every concurrent register/unregister behind the entire
	// fan-out — under load (alert evaluator firing fan-out + new
	// connections opening) that can starve the hub for seconds. The
	// snapshot is cheap because c.role is filtered first.
	h.mu.RLock()
	matched := make([]*Client, 0)
	for c := range h.clients {
		if c.role == role {
			matched = append(matched, c)
		}
	}
	h.mu.RUnlock()

	delivered := 0
	for _, c := range matched {
		select {
		case c.send <- message:
			delivered++
		default:
			slog.Warn("dropping role-targeted frame to slow client",
				"role", role, "addr", c.conn.RemoteAddr())
		}
	}
	return delivered
}

// PushToUser delivers a message to every client authenticated as the given
// user (often 0, 1, or 2 — a phone + a desktop). Guests (userID=0) never
// receive pushes even if the caller passes 0 by accident. Returns the
// number of clients the message was dispatched to; slow clients drop the
// frame (same policy as the broadcast path) rather than block the caller.
//
// Safe to call from background goroutines — reads the client set under
// RLock and writes to buffered channels.
func (h *Hub) PushToUser(userID int, message []byte) int {
	if userID <= 0 || len(message) == 0 {
		return 0
	}
	// Snapshot the matching clients (typically 0–2) under RLock, then
	// release before sending. See PushToRole for the rationale: holding
	// the lock across channel sends starves register/unregister under
	// fan-out load.
	h.mu.RLock()
	matched := make([]*Client, 0, 2)
	for c := range h.clients {
		if c.userID == userID {
			matched = append(matched, c)
		}
	}
	h.mu.RUnlock()

	delivered := 0
	for _, c := range matched {
		select {
		case c.send <- message:
			delivered++
		default:
			// Slow client — don't block the evaluator on a stalled peer.
			// The broadcast loop will evict via the send path next tick.
			slog.Warn("dropping user-targeted frame to slow client",
				"user_id", userID, "addr", c.conn.RemoteAddr())
		}
	}
	return delivered
}

// Client is a middleman between the websocket connection and the hub.
type Client struct {
	hub *Hub

	// The websocket connection.
	conn *websocket.Conn

	// Buffered channel of outbound messages.
	send chan []byte

	// userID is the authenticated user behind the connection, or 0 for
	// guests. Stamped during the WS upgrade in HandleWS and used by
	// Hub.PushToUser to route user-targeted frames (alert notifications,
	// future personalised feeds) to exactly the clients that should see
	// them. Guests never receive user-targeted pushes.
	userID int

	// role is the authenticated user's role at upgrade time ("user",
	// "pro", "admin", etc.) or empty for guests. Used by Hub.PushToRole
	// for class-of-user fan-out (admins receiving pro-role-request
	// notifications). A role change mid-session won't propagate until
	// the next reconnect — acceptable because role changes are rare
	// and clients re-establish the WS on every page load.
	role string
}

func (c *Client) WritePump() {
	ticker := time.NewTicker(wsPingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			// Write deadline guards against a stalled peer (full TCP
			// window, dropped cellular connection) holding this goroutine
			// hostage. Without it a single hung client can pin a socket +
			// goroutine indefinitely.
			c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if !ok {
				// Hub closed the send channel during unregister — send a
				// clean close frame so the peer sees a graceful goodbye.
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)
			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			// Periodic ping doubles as a liveness probe. If the write
			// fails (or the peer never pongs within wsPongWait back in the
			// read pump), we close and the hub cleans up.
			c.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
