package server

import (
	"testing"
	"time"

	"github.com/teckdroids/ges-data-engine/internal/repository"
	"golang.org/x/crypto/bcrypt"
)

// An unknown username used to return before bcrypt ran, while a known one
// returned after it — roughly 250ms apart at cost 12, which is a reliable
// "does this account exist" oracle from anywhere on the internet.
//
// The handler now always spends one comparison. This measures the decoy
// path against a real one to show they cost the same.
func TestDecoyHash_CostsTheSameAsARealComparison(t *testing.T) {
	realHash, err := bcrypt.GenerateFromPassword([]byte("correct-horse-9"), repository.BcryptCost)
	if err != nil {
		t.Fatalf("GenerateFromPassword: %v", err)
	}

	measure := func(hash []byte) time.Duration {
		start := time.Now()
		_ = bcrypt.CompareHashAndPassword(hash, []byte("some-guess-123"))
		return time.Since(start)
	}

	// Warm up so the first call's page faults don't skew the comparison.
	measure(realHash)
	measure(decoyHash)

	realDur, decoyDur := measure(realHash), measure(decoyHash)

	// The two must be the same order of magnitude. A decoy built at a
	// different cost would be off by a factor of two per cost step, which
	// is exactly the signal this is meant to remove.
	ratio := float64(decoyDur) / float64(realDur)
	if ratio < 0.5 || ratio > 2.0 {
		t.Errorf("decoy comparison took %v vs %v for a real hash (ratio %.2f); "+
			"the timing signal the decoy exists to remove is still present",
			decoyDur, realDur, ratio)
	}

	// And it must genuinely be a bcrypt hash at the project's cost, not a
	// placeholder that fails fast.
	cost, err := bcrypt.Cost(decoyHash)
	if err != nil {
		t.Fatalf("decoyHash is not a valid bcrypt digest: %v", err)
	}
	if cost != repository.BcryptCost {
		t.Errorf("decoyHash cost = %d, want %d", cost, repository.BcryptCost)
	}
}

// No password should ever verify against the decoy.
func TestDecoyHash_NeverMatches(t *testing.T) {
	for _, guess := range []string{"", "password", "admin", "correct-horse-9", string(decoyHash)} {
		if bcrypt.CompareHashAndPassword(decoyHash, []byte(guess)) == nil {
			t.Errorf("guess %q verified against the decoy hash", guess)
		}
	}
}
