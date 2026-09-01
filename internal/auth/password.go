package auth

import (
	"errors"
	"unicode"
)

// ErrWeakPassword is returned by ValidatePassword when the supplied password
// fails one or more strength rules. The error message is intentionally
// human-readable so handlers can pass it straight back to the client.
var ErrWeakPassword = errors.New("password must be at least 8 characters and include a letter and a digit")

// MinPasswordLength is the absolute minimum we accept anywhere — signup,
// admin reset, password change.
const MinPasswordLength = 8

// ValidatePassword enforces a single, project-wide password policy. Keep
// this strict enough to defeat trivial brute force, lenient enough that
// users actually comply (no special-character requirement — research shows
// length matters more than character classes).
//
// Rules:
//  1. At least MinPasswordLength characters.
//  2. Contains at least one letter.
//  3. Contains at least one digit.
//  4. Not entirely whitespace.
func ValidatePassword(p string) error {
	if len(p) < MinPasswordLength {
		return ErrWeakPassword
	}
	var hasLetter, hasDigit, hasNonSpace bool
	for _, r := range p {
		switch {
		case unicode.IsLetter(r):
			hasLetter = true
			hasNonSpace = true
		case unicode.IsDigit(r):
			hasDigit = true
			hasNonSpace = true
		case !unicode.IsSpace(r):
			hasNonSpace = true
		}
	}
	if !hasLetter || !hasDigit || !hasNonSpace {
		return ErrWeakPassword
	}
	return nil
}
