package analysis

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ─── Shared LLM retry ladder ──────────────────────────────────────────

// llmRetryBackoffs controls the exponential-backoff ladder applied to
// every non-Gemini provider (Anthropic, OpenAI) per single model call.
// Matches geminiRetryBackoffs shape so tests can override either to 0.
// Index 0 (immediate) + 1s + 3s = ~4s total wait across 3 tries,
// comfortably inside the server's 30s write timeout.
var llmRetryBackoffs = []time.Duration{0, 1 * time.Second, 3 * time.Second}

// retryLLMCall runs `do` through the backoff ladder, treating any
// error wrapping `errLLMProviderTransient` as retryable. Used by the
// Anthropic + OpenAI clients so their retry logic stays DRY.
func retryLLMCall(ctx context.Context, clientName string, do func(ctx context.Context) (string, error)) (string, error) {
	var lastErr error
	for attempt, backoff := range llmRetryBackoffs {
		if backoff > 0 {
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		text, err := do(ctx)
		if err == nil {
			return text, nil
		}
		lastErr = err
		if !errors.Is(err, errLLMProviderTransient) {
			return "", err
		}
		slog.Warn("[llm] attempt failed, will retry", "client", clientName, "attempt", attempt+1, "error", err)
	}
	return "", fmt.Errorf("%w: %s: %v", ErrLLMUnavailable, clientName, lastErr)
}

// errLLMProviderTransient is the retryable-failure sentinel used by
// the shared retry helper. Callers wrap their per-request transport
// + 429/5xx failures with this; permanent 4xx (bad auth, bad payload)
// is surfaced directly so retrying against the same provider would
// just waste budget.
var errLLMProviderTransient = errors.New("llm provider transient failure")

// ─── Gemini LLM client ─────────────────────────────────────────────────────

// GeminiClient is an LLMClient backed by Google's generativelanguage API. It
// is provided here so the analysis package fully owns the LLM integration;
// the server layer just constructs one and passes it into NewInsightService.
//
// Two resilience layers sit on top of the raw HTTP call:
//
//  1. Exponential backoff on retryable status codes (429, 5xx) across
//     three attempts with 0 / 1s / 3s waits. Total worst-case wait is
//     ~4s, which keeps room under the server's 30s write timeout.
//  2. Model fallback chain — if the primary model (gemini-2.0-flash)
//     still returns a retryable error after its retry budget, fall
//     back to gemini-2.0-flash-lite which has its own quota bucket.
//
// Per-prompt singleflight dedup and cross-provider fallback (Claude,
// OpenAI) live in FallbackLLMClient — this client only concerns
// itself with making Gemini succeed, or surfacing ErrLLMUnavailable
// so the outer wrapper knows it's safe to try a different provider.
type GeminiClient struct {
	apiKey     string
	httpClient *http.Client
}

// geminiRetryBackoffs controls the exponential-backoff ladder for a
// single model attempt. Each entry is the sleep BEFORE that try, so
// index 0 (immediate) plus 1s + 3s = 4s total wait across 3 tries.
// Kept as a package var so tests can override to zero.
var geminiRetryBackoffs = []time.Duration{0, 1 * time.Second, 3 * time.Second}

// geminiModelChain is the ordered list of models tried for each
// prompt. The primary is faster/larger; the fallback trades a bit of
// quality for a separate quota bucket when the primary is throttled.
// Listed most-preferred first.
var geminiModelChain = []string{"gemini-2.0-flash", "gemini-2.0-flash-lite"}

// errRateLimited is returned internally when the upstream responded
// with 429 or a 5xx. Used to decide between "retry / fall back" and
// "fail now" without re-parsing status codes at every layer. Callers
// outside this file see ErrLLMUnavailable instead — that's the
// stable sentinel the provider-fallback layer watches for.
var errRateLimited = errors.New("gemini rate limited or transient failure")

func NewGeminiClient(apiKey string, httpClient *http.Client) *GeminiClient {
	return &GeminiClient{apiKey: apiKey, httpClient: httpClient}
}

// Generate calls Gemini with the given prompt, stepping through the
// model chain on persistent rate-limit errors. Callers get back the
// first non-empty text, ErrLLMUnavailable if the whole chain is
// throttled (so FallbackLLMClient can try another provider), or a
// concrete error for permanent failures (bad key, malformed response).
func (g *GeminiClient) Generate(ctx context.Context, prompt string) (string, error) {
	if g.apiKey == "" {
		return "", errors.New("gemini api key not configured")
	}
	bodyBytes, err := json.Marshal(map[string]interface{}{
		"contents": []map[string]interface{}{
			{"parts": []map[string]interface{}{{"text": prompt}}},
		},
	})
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	var lastErr error
	for i, model := range geminiModelChain {
		text, err := g.generateWithRetries(ctx, model, bodyBytes)
		if err == nil {
			if i > 0 {
				slog.Info("[gemini] fallback model succeeded", "model", model)
			}
			return text, nil
		}
		lastErr = err
		// Non-retryable errors (bad key, malformed response, context
		// cancel) surface immediately — trying the next model won't
		// help and would just waste budget. Wrap context errors as
		// permanent too so the outer FallbackLLMClient doesn't
		// retry against other providers on a cancelled request.
		if !errors.Is(err, errRateLimited) {
			return "", err
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if i < len(geminiModelChain)-1 {
			slog.Warn("[gemini] model exhausted retries, falling back", "from", model, "to", geminiModelChain[i+1])
		}
	}
	// Entire Gemini model chain exhausted with rate-limit errors —
	// surface as ErrLLMUnavailable so the outer fallback layer can
	// try Claude / OpenAI.
	return "", fmt.Errorf("%w: gemini: %v", ErrLLMUnavailable, lastErr)
}

// generateWithRetries calls a single model with the exponential-backoff
// ladder. Retries only on errRateLimited (429 / 5xx); returns
// immediately on permanent failures.
func (g *GeminiClient) generateWithRetries(ctx context.Context, model string, bodyBytes []byte) (string, error) {
	var lastErr error
	for attempt, backoff := range geminiRetryBackoffs {
		if backoff > 0 {
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		text, err := g.generateOnce(ctx, model, bodyBytes)
		if err == nil {
			return text, nil
		}
		lastErr = err
		if !errors.Is(err, errRateLimited) {
			return "", err
		}
		slog.Warn("[gemini] attempt failed, will retry", "model", model, "attempt", attempt+1, "error", err)
	}
	return "", lastErr
}

// generateOnce issues a single API call to the named model. Returns
// errRateLimited for 429/5xx so the retry + fallback layers can
// decide what to do.
func (g *GeminiClient) generateOnce(ctx context.Context, model string, bodyBytes []byte) (string, error) {
	url := "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + g.apiKey
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := g.httpClient.Do(req)
	if err != nil {
		// Transport errors (timeout, reset) are treated as retryable —
		// the next attempt may land on a healthy path.
		return "", fmt.Errorf("%w: %v", errRateLimited, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		_, _ = io.Copy(io.Discard, resp.Body) // drain so the connection can be reused
		return "", fmt.Errorf("%w: status %d", errRateLimited, resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("gemini status %d", resp.StatusCode)
	}

	var resData struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&resData); err != nil {
		return "", err
	}
	if len(resData.Candidates) == 0 || len(resData.Candidates[0].Content.Parts) == 0 {
		return "", errors.New("empty gemini response")
	}
	return resData.Candidates[0].Content.Parts[0].Text, nil
}

// ─── Anthropic (Claude) client ────────────────────────────────────────

// AnthropicClient implements LLMClient via Anthropic's Messages API.
// Used as a fallback when Gemini's entire model chain is throttled —
// Claude and Gemini have independent rate limits, so provider-level
// failover buys you a whole new bucket without upgrading any tier.
type AnthropicClient struct {
	apiKey     string
	model      string
	httpClient *http.Client
}

// DefaultAnthropicModel is fast, cheap, and broadly available to any
// Anthropic account with Claude access. "latest" is the alias
// Anthropic promotes to the newest non-deprecated snapshot — avoids
// dated suffixes (e.g. claude-haiku-4-5-20251001) that 400 for keys
// on accounts without explicit access to that snapshot. Callers
// holding Claude 4.x access can override via the `model` arg on
// NewAnthropicClient.
const DefaultAnthropicModel = "claude-3-5-haiku-latest"

// anthropicMaxTokens caps the Messages API response length. The AI
// Oracle prompt asks for ~2-3 sentences; 1024 tokens is plenty of
// headroom while keeping the per-call cost bounded.
const anthropicMaxTokens = 1024

// anthropicAPIVersion is required by the Anthropic Messages API —
// pinned here so upgrades are an intentional edit.
const anthropicAPIVersion = "2023-06-01"

// NewAnthropicClient constructs a Claude-backed LLMClient. Pass an
// empty string as `model` to use DefaultAnthropicModel.
func NewAnthropicClient(apiKey, model string, httpClient *http.Client) *AnthropicClient {
	if model == "" {
		model = DefaultAnthropicModel
	}
	return &AnthropicClient{apiKey: apiKey, model: model, httpClient: httpClient}
}

// Generate issues a Messages request to Anthropic with the standard
// retry ladder. Returns ErrLLMUnavailable when the retry budget is
// exhausted so the outer fallback can try the next provider.
func (c *AnthropicClient) Generate(ctx context.Context, prompt string) (string, error) {
	if c.apiKey == "" {
		return "", errors.New("anthropic api key not configured")
	}
	bodyBytes, err := json.Marshal(map[string]interface{}{
		"model":      c.model,
		"max_tokens": anthropicMaxTokens,
		"messages": []map[string]interface{}{
			{"role": "user", "content": prompt},
		},
	})
	if err != nil {
		return "", fmt.Errorf("marshal anthropic request: %w", err)
	}

	return retryLLMCall(ctx, "anthropic", func(ctx context.Context) (string, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(bodyBytes))
		if err != nil {
			return "", err
		}
		req.Header.Set("x-api-key", c.apiKey)
		req.Header.Set("anthropic-version", anthropicAPIVersion)
		req.Header.Set("Content-Type", "application/json")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return "", fmt.Errorf("%w: transport: %v", errLLMProviderTransient, err)
		}
		defer resp.Body.Close()

		// 429 (rate limit) + 529 (overloaded) + any 5xx are retryable.
		// Anthropic uses 529 specifically to signal "try again shortly".
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == 529 || resp.StatusCode >= 500 {
			_, _ = io.Copy(io.Discard, resp.Body)
			return "", fmt.Errorf("%w: status %d", errLLMProviderTransient, resp.StatusCode)
		}
		if resp.StatusCode != http.StatusOK {
			// Drain the body into the error so 4xx root causes
			// (bad model id, deprecated model, malformed payload)
			// surface in logs instead of just "anthropic status 400".
			// Capped so a giant error page can't blow up log lines.
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			return "", fmt.Errorf("anthropic status %d: %s", resp.StatusCode, bytes.TrimSpace(body))
		}

		var res struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
			return "", err
		}
		// Messages API returns an array of content blocks; concatenate
		// every text block so multi-paragraph responses come through
		// intact (non-text blocks like tool_use are skipped silently).
		var out string
		for _, b := range res.Content {
			if b.Type == "text" {
				out += b.Text
			}
		}
		if out == "" {
			return "", errors.New("empty anthropic response")
		}
		return out, nil
	})
}

// ─── OpenAI-compatible Chat Completions client ────────────────────────

// OpenAICompatibleClient implements LLMClient against any endpoint that
// speaks OpenAI's POST /chat/completions contract. That covers OpenAI
// itself plus self-hosted runtimes (Ollama, vLLM, llama.cpp, LM Studio)
// and aggregators (OpenRouter, Groq, Together, LiteLLM) — the request and
// response shapes are identical, only the base URL, credential, and model
// name change.
//
// Two things differ from the hosted-OpenAI assumption and are why this
// isn't just a base-URL field on OpenAIClient:
//
//   - APIKey is optional. A local Ollama has no auth, and sending an
//     empty bearer token makes some servers reject the request outright,
//     so the header is omitted entirely when the key is empty.
//   - Headers carries provider-specific extras (OpenRouter's HTTP-Referer
//     and X-Title, an Azure api-key, a gateway's tenant header) without
//     needing a new client type for each one.
type OpenAICompatibleClient struct {
	name       string
	baseURL    string
	apiKey     string
	model      string
	headers    map[string]string
	httpClient *http.Client
}

// OpenAICompatibleConfig configures an OpenAICompatibleClient. BaseURL
// and Model are required; everything else is optional.
type OpenAICompatibleConfig struct {
	// Name labels the provider in retry logs and error messages, e.g.
	// "ollama". Defaults to "openai-compatible".
	Name string
	// BaseURL is the API root, with or without a trailing /v1 and with or
	// without a trailing slash: "http://localhost:11434/v1",
	// "https://openrouter.ai/api/v1", "https://api.groq.com/openai/v1".
	// Passing a full ".../chat/completions" URL also works.
	BaseURL string
	// APIKey is sent as a bearer token. Leave empty for unauthenticated
	// local servers — no Authorization header is sent at all.
	APIKey string
	// Model is the model identifier the endpoint expects, e.g.
	// "llama3.1:8b" or "meta-llama/llama-3.1-70b-instruct". Required:
	// there's no sane default across arbitrary providers.
	Model string
	// Headers are extra request headers, applied after the defaults so a
	// caller can override Authorization if the provider wants a different
	// scheme.
	Headers    map[string]string
	HTTPClient *http.Client
}

const defaultCompatibleName = "openai-compatible"

// chatCompletionsPath is appended to a configured base URL.
const chatCompletionsPath = "/chat/completions"

// NewOpenAICompatibleClient builds a client for an OpenAI-shaped endpoint.
// It returns an error rather than a half-configured client so a typo in
// the base URL surfaces at boot instead of at first insight request.
func NewOpenAICompatibleClient(cfg OpenAICompatibleConfig) (*OpenAICompatibleClient, error) {
	if cfg.BaseURL == "" {
		return nil, errors.New("openai-compatible: base URL is required")
	}
	if cfg.Model == "" {
		return nil, errors.New("openai-compatible: model is required")
	}
	endpoint, err := chatCompletionsURL(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	name := cfg.Name
	if name == "" {
		name = defaultCompatibleName
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &OpenAICompatibleClient{
		name:       name,
		baseURL:    endpoint,
		apiKey:     cfg.APIKey,
		model:      cfg.Model,
		headers:    cfg.Headers,
		httpClient: httpClient,
	}, nil
}

// chatCompletionsURL normalises a configured base URL into the full
// completions endpoint. Accepts a bare root, a trailing slash, or a URL
// that already names the endpoint — the three shapes people actually
// paste out of provider docs.
func chatCompletionsURL(base string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(base), "/")
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("openai-compatible: parse base URL %q: %w", base, err)
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("openai-compatible: base URL %q needs a scheme and host", base)
	}
	if strings.HasSuffix(u.Path, chatCompletionsPath) {
		return trimmed, nil
	}
	return trimmed + chatCompletionsPath, nil
}

// Generate issues a Chat Completions request with the standard retry
// ladder. Returns ErrLLMUnavailable when the retry budget is exhausted so
// FallbackLLMClient knows it may move to the next provider.
func (c *OpenAICompatibleClient) Generate(ctx context.Context, prompt string) (string, error) {
	bodyBytes, err := json.Marshal(map[string]interface{}{
		"model": c.model,
		"messages": []map[string]interface{}{
			{"role": "user", "content": prompt},
		},
	})
	if err != nil {
		return "", fmt.Errorf("marshal %s request: %w", c.name, err)
	}

	return retryLLMCall(ctx, c.name, func(ctx context.Context) (string, error) {
		req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL, bytes.NewReader(bodyBytes))
		if err != nil {
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		// Unauthenticated local runtimes reject a bare "Bearer " prefix,
		// so only send the header when there's something to send.
		if c.apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+c.apiKey)
		}
		for k, v := range c.headers {
			req.Header.Set(k, v)
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return "", fmt.Errorf("%w: transport: %v", errLLMProviderTransient, err)
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			_, _ = io.Copy(io.Discard, resp.Body)
			return "", fmt.Errorf("%w: status %d", errLLMProviderTransient, resp.StatusCode)
		}
		if resp.StatusCode != http.StatusOK {
			// Surface the body so 4xx root causes (bad model,
			// quota issues, malformed prompt) are diagnosable
			// without an extra request. Capped for safety.
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			return "", fmt.Errorf("%s status %d: %s", c.name, resp.StatusCode, bytes.TrimSpace(body))
		}

		var res struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
			// Some gateways answer 200 with an error object instead of
			// an HTTP error code; without this the caller would just
			// see "empty response" and no reason.
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
			return "", err
		}
		if res.Error.Message != "" {
			return "", fmt.Errorf("%s: %s", c.name, res.Error.Message)
		}
		if len(res.Choices) == 0 || res.Choices[0].Message.Content == "" {
			return "", fmt.Errorf("empty %s response", c.name)
		}
		return res.Choices[0].Message.Content, nil
	})
}

// ─── OpenAI (ChatGPT) client ──────────────────────────────────────────

// openAIBaseURL is the hosted OpenAI API root.
const openAIBaseURL = "https://api.openai.com/v1"

// OpenAIClient implements LLMClient via OpenAI's Chat Completions API.
// Deployed as the second-level fallback behind Anthropic — three
// providers give us three independent quota buckets and a realistic
// chance of staying up even if two are throttled simultaneously.
//
// It's a preconfigured OpenAICompatibleClient: the hosted API is just
// the reference implementation of that same contract.
type OpenAIClient struct {
	*OpenAICompatibleClient
	apiKey string
}

// DefaultOpenAIModel is the Chat Completions counterpart to
// DefaultAnthropicModel — cheap, fast, good enough for the 2-3
// sentence AI Oracle summary. Callers can override via the
// `model` arg on NewOpenAIClient.
const DefaultOpenAIModel = "gpt-4o-mini"

// NewOpenAIClient constructs a ChatGPT-backed LLMClient. Pass an
// empty string as `model` to use DefaultOpenAIModel.
func NewOpenAIClient(apiKey, model string, httpClient *http.Client) *OpenAIClient {
	if model == "" {
		model = DefaultOpenAIModel
	}
	// Errors here are impossible: the base URL is a compile-time constant
	// and the model is non-empty by the line above.
	compat, _ := NewOpenAICompatibleClient(OpenAICompatibleConfig{
		Name:       "openai",
		BaseURL:    openAIBaseURL,
		APIKey:     apiKey,
		Model:      model,
		HTTPClient: httpClient,
	})
	return &OpenAIClient{OpenAICompatibleClient: compat, apiKey: apiKey}
}

// Generate rejects an unconfigured key up front — the hosted API always
// requires one, so failing here beats spending the retry ladder on three
// guaranteed 401s.
func (c *OpenAIClient) Generate(ctx context.Context, prompt string) (string, error) {
	if c.apiKey == "" {
		return "", errors.New("openai api key not configured")
	}
	return c.OpenAICompatibleClient.Generate(ctx, prompt)
}
