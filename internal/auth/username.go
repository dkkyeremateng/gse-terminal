package auth

import (
	"errors"
	"regexp"
	"strings"
)

// ErrInvalidUsername is returned by ValidateUsername when the supplied
// username doesn't match the canonical format. Surfaced to users
// verbatim so they understand the rule.
var ErrInvalidUsername = errors.New("username must be 3–32 characters and contain only lowercase letters, digits, underscore, or dash")

// usernameRe enforces an ASCII-only, lowercase canonical form. The
// charset whitelist is the load-bearing security property — without it,
// signups can use Unicode lookalikes (e.g. Cyrillic 'а' vs Latin 'a',
// zero-width spaces) to register visually identical handles to existing
// admins, enabling phishing/social engineering. Lowercase-only also
// short-circuits "Admin"/"ADMIN"/"admin" case-impersonation: every
// username collapses to one canonical form before storage and lookup.
var usernameRe = regexp.MustCompile(`^[a-z0-9_-]{3,32}$`)

// usernameSanitizeRe matches any character that's NOT in the username
// whitelist; used by SanitizeUsername to coerce OAuth-derived names
// (which may include "+", ".", or non-ASCII) into the canonical format.
var usernameSanitizeRe = regexp.MustCompile(`[^a-z0-9_-]+`)

// NormalizeUsername returns the canonical form used for storage AND
// lookup: lowercase + trimmed. Apply this before every DB read or write
// so case-only differences never produce divergent rows.
func NormalizeUsername(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// ValidateUsername enforces the canonical format on a (already-normalized)
// username. Reject early at the HTTP boundary on signup so case-only
// or Unicode-lookalike handles never reach the database.
func ValidateUsername(s string) error {
	if !usernameRe.MatchString(s) {
		return ErrInvalidUsername
	}
	return nil
}

// SanitizeUsername coerces an arbitrary string (typically the local
// part of an email address from an OAuth provider) into a username that
// satisfies ValidateUsername. Replaces invalid characters with "_",
// pads short results, and truncates long ones. The caller is still
// responsible for collision retries — this function only enforces the
// charset/length contract, not uniqueness.
func SanitizeUsername(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = usernameSanitizeRe.ReplaceAllString(s, "_")
	s = strings.Trim(s, "_-")
	if len(s) < 3 {
		s = s + "_user"
	}
	if len(s) > 32 {
		s = s[:32]
	}
	return s
}
