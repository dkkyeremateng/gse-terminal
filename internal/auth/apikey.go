package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// API key format: "ges_live_" + 32 hex chars (16 random bytes).
// Total length 41. The full key is shown to the user exactly once at
// creation; only the SHA-256 hash is persisted.
const apiKeyPrefix = "ges_live_"

// GenerateAPIKey returns (rawKey, displayPrefix, sha256Hash). displayPrefix
// is "ges_live_xxxx…" — the first 12 chars of the raw key — safe to store
// and surface in the UI as an identifier.
func GenerateAPIKey() (string, string, string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", "", "", fmt.Errorf("rand: %w", err)
	}
	body := hex.EncodeToString(b)
	raw := apiKeyPrefix + body
	display := raw[:12] + "…"
	hash := HashAPIKey(raw)
	return raw, display, hash, nil
}

// HashAPIKey returns the canonical hex SHA-256 of the raw key. Used both at
// creation time and on every request to find the matching row.
func HashAPIKey(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

// LooksLikeAPIKey returns true when the supplied bearer token has the API
// key prefix. Used by the auth middleware to decide whether to validate the
// token as a JWT or hash-and-look-up as an API key.
func LooksLikeAPIKey(token string) bool {
	return strings.HasPrefix(token, apiKeyPrefix)
}
