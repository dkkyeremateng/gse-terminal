package server

import (
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/teckdroids/ges-data-engine/internal/auth"
)

func (s *Server) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		// gorilla/websocket writes the HTTP error response internally;
		// we only need to log. Use Warn, not Error — upgrade failures
		// from bots/scanners are expected noise in production.
		LoggerFromCtx(r.Context()).Warn("WebSocket upgrade failure", "error", err, "remote", r.RemoteAddr)
		return
	}

	// Cap inbound frame size + set a read deadline. If no frame (data,
	// pong, or close) lands within wsPongWait we treat the peer as dead
	// and break out of the loop, freeing the goroutine + socket pair.
	// The pong handler extends the deadline each time the peer answers
	// a ping, so active clients stay connected indefinitely while silent
	// / stalled ones get reaped in under a minute.
	conn.SetReadLimit(wsMaxMessageSize)
	conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	// Stamp the authenticated user on the client so Hub.PushToUser can
	// target this connection for alert notifications. FromContext returns
	// a guest (IsGuest == true, ID == 0) when the caller isn't logged in;
	// PushToUser ignores userID == 0 so guests never receive pushes.
	user := auth.FromContext(r.Context())
	client := &Client{
		hub:    s.Hub,
		conn:   conn,
		send:   make(chan []byte, 256),
		userID: user.ID,
		role:   user.Role,
	}

	s.Hub.register <- client

	go client.WritePump()

	defer func() {
		s.Hub.unregister <- client
		conn.Close()
	}()

	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			// IsUnexpectedCloseError returns true (= we log) for every
			// close code NOT in the expected list. The four codes below
			// cover every normal disconnect path:
			//   1000 CloseNormalClosure   — clean ws.close() from JS,
			//                                including our visibilitychange
			//                                handler when a tab backgrounds.
			//   1001 CloseGoingAway        — browser tab/window closed.
			//   1005 CloseNoStatusReceived — peer dropped without a close
			//                                frame (pseudo-code; common on
			//                                flaky mobile networks).
			//   1006 CloseAbnormalClosure  — TCP reset / network blip
			//                                (pseudo-code).
			// Anything else (protocol errors 1002/1003/1007/1008, policy
			// violation, internal error 1011) is actually worth surfacing,
			// but at Warn — nothing here is ops-actionable, and Error was
			// generating spam on every tab switch.
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
				websocket.CloseNoStatusReceived,
				websocket.CloseAbnormalClosure,
			) {
				LoggerFromCtx(r.Context()).Warn("WebSocket read error", "error", err, "remote", r.RemoteAddr)
			}
			break
		}
	}
}
