package analysis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"

	"golang.org/x/sync/singleflight"
)

// FallbackLLMClient wraps a prioritized chain of LLMClient providers
// and serves a single unified Generate. It does two things on top of
// a bare client:
//
//  1. singleflight dedup per-prompt so concurrent identical requests
//     across the whole chain collapse to one upstream call — the
//     biggest RPM saver when the Redis cache is cold and multiple
//     tabs open the same stock at the same time.
//
//  2. Sequential provider fallback — if a client returns
//     ErrLLMUnavailable (its internal retry budget couldn't break a
//     rate-limit / transient failure), try the next provider. A
//     permanent error (bad prompt, cancelled context, malformed
//     response) short-circuits the chain so we don't waste budget
//     on a call that can't succeed anywhere.
//
// Composition order reflects operational preference — typically
// Gemini (primary, cheap, free tier), then Claude (quality fallback),
// then ChatGPT (broadest quota bucket). Each provider has its own
// internal retry ladder; this wrapper just chooses which one to talk
// to next.
type FallbackLLMClient struct {
	clients []LLMClient
	sf      singleflight.Group
}

// NewFallbackLLMClient returns a chain over the given providers. Zero
// clients returns a stub that always errors — intentional, so a
// misconfigured deploy fails fast instead of silently rendering the
// AI Oracle blank. Use this wrapper even for a single-provider setup
// to keep the singleflight dedup benefits.
func NewFallbackLLMClient(clients ...LLMClient) *FallbackLLMClient {
	return &FallbackLLMClient{clients: clients}
}

// Generate walks the provider chain under a singleflight lock keyed
// off a SHA-256 hash of the prompt. The first success short-circuits
// the rest; the first provider to return a permanent error short-
// circuits too (retrying against another provider won't help when
// the prompt itself is broken).
func (f *FallbackLLMClient) Generate(ctx context.Context, prompt string) (string, error) {
	if len(f.clients) == 0 {
		return "", errors.New("no llm providers configured")
	}

	// Hash the prompt so the singleflight key stays bounded regardless
	// of prompt length — AI-oracle prompts bundle news headlines + a
	// technical block and can run into low-KB range. Same shape as the
	// pre-refactor Gemini-side dedup.
	h := sha256.Sum256([]byte(prompt))
	key := hex.EncodeToString(h[:])

	v, err, _ := f.sf.Do(key, func() (interface{}, error) {
		return f.generateSequential(ctx, prompt)
	})
	if err != nil {
		return "", err
	}
	return v.(string), nil
}

// generateSequential walks the provider chain once. Separated out so
// singleflight's closure stays readable — the first call for a given
// prompt owns the chain walk; other callers with the same prompt
// wait on the same promise and inherit its result.
func (f *FallbackLLMClient) generateSequential(ctx context.Context, prompt string) (string, error) {
	var lastErr error
	for i, client := range f.clients {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		text, err := client.Generate(ctx, prompt)
		if err == nil {
			if i > 0 {
				slog.Info("[llm] provider fallback succeeded", "index", i)
			}
			return text, nil
		}
		lastErr = err
		// Only keep trying if this provider reported "unavailable"
		// (rate-limited / transient). A permanent error (bad key,
		// bad prompt, malformed response, cancelled ctx) means the
		// request itself is busted — the next provider will hit the
		// same wall, just more expensively.
		if !errors.Is(err, ErrLLMUnavailable) {
			return "", err
		}
		if i < len(f.clients)-1 {
			slog.Warn("[llm] provider exhausted, trying next",
				"failed_index", i, "total_providers", len(f.clients))
		}
	}
	return "", fmt.Errorf("all llm providers unavailable: %w", lastErr)
}
