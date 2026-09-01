package analysis

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// zeroBackoffs strips the retry sleeps for the duration of a test so the
// retry ladder runs instantly.
func zeroBackoffs(t *testing.T) {
	t.Helper()
	orig := llmRetryBackoffs
	llmRetryBackoffs = []time.Duration{0, 0, 0}
	t.Cleanup(func() { llmRetryBackoffs = orig })
}

// chatResponse builds a minimal Chat Completions success body.
func chatResponse(content string) string {
	quoted, _ := json.Marshal(content)
	return `{"choices":[{"message":{"role":"assistant","content":` + string(quoted) + `}}]}`
}

func TestOpenAICompatibleGenerate(t *testing.T) {
	var gotPath, gotAuth, gotContentType, gotExtra string
	var gotBody map[string]interface{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		gotExtra = r.Header.Get("HTTP-Referer")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, chatResponse("MTNGH held flat on thin volume."))
	}))
	defer srv.Close()

	client, err := NewOpenAICompatibleClient(OpenAICompatibleConfig{
		Name:       "openrouter",
		BaseURL:    srv.URL + "/api/v1",
		APIKey:     "sk-test",
		Model:      "meta-llama/llama-3.1-70b-instruct",
		Headers:    map[string]string{"HTTP-Referer": "https://gse.teckdroids.com"},
		HTTPClient: srv.Client(),
	})
	if err != nil {
		t.Fatalf("construct: %v", err)
	}

	out, err := client.Generate(context.Background(), "summarise MTNGH")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if out != "MTNGH held flat on thin volume." {
		t.Errorf("content = %q", out)
	}
	if gotPath != "/api/v1/chat/completions" {
		t.Errorf("path = %q, want /api/v1/chat/completions", gotPath)
	}
	if gotAuth != "Bearer sk-test" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q", gotContentType)
	}
	if gotExtra != "https://gse.teckdroids.com" {
		t.Errorf("extra header not sent, got %q", gotExtra)
	}
	if gotBody["model"] != "meta-llama/llama-3.1-70b-instruct" {
		t.Errorf("model = %v", gotBody["model"])
	}
	msgs, _ := gotBody["messages"].([]interface{})
	if len(msgs) != 1 {
		t.Fatalf("messages = %v", gotBody["messages"])
	}
	first, _ := msgs[0].(map[string]interface{})
	if first["role"] != "user" || first["content"] != "summarise MTNGH" {
		t.Errorf("message = %v", first)
	}
}

// An unauthenticated local runtime (Ollama, llama.cpp) rejects a bare
// "Bearer " prefix, so no header at all must be sent when the key is empty.
func TestOpenAICompatibleOmitsEmptyAuthHeader(t *testing.T) {
	seen := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, seen = r.Header["Authorization"]
		_, _ = io.WriteString(w, chatResponse("ok"))
	}))
	defer srv.Close()

	client, err := NewOpenAICompatibleClient(OpenAICompatibleConfig{
		BaseURL: srv.URL + "/v1", Model: "llama3.1:8b", HTTPClient: srv.Client(),
	})
	if err != nil {
		t.Fatalf("construct: %v", err)
	}
	if _, err := client.Generate(context.Background(), "hi"); err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if seen {
		t.Error("Authorization header sent despite empty API key")
	}
}

func TestChatCompletionsURL(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "http://localhost:11434/v1", want: "http://localhost:11434/v1/chat/completions"},
		{in: "http://localhost:11434/v1/", want: "http://localhost:11434/v1/chat/completions"},
		{in: "  https://openrouter.ai/api/v1  ", want: "https://openrouter.ai/api/v1/chat/completions"},
		// Already a full endpoint — don't double up.
		{in: "https://api.groq.com/openai/v1/chat/completions", want: "https://api.groq.com/openai/v1/chat/completions"},
		{in: "localhost:11434", wantErr: true},
		{in: "not a url", wantErr: true},
	}
	for _, tc := range cases {
		got, err := chatCompletionsURL(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("chatCompletionsURL(%q) = %q, want error", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("chatCompletionsURL(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("chatCompletionsURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestOpenAICompatibleRequiredFields(t *testing.T) {
	if _, err := NewOpenAICompatibleClient(OpenAICompatibleConfig{Model: "m"}); err == nil {
		t.Error("missing base URL accepted")
	}
	if _, err := NewOpenAICompatibleClient(OpenAICompatibleConfig{BaseURL: "http://x/v1"}); err == nil {
		t.Error("missing model accepted")
	}
}

// 429 exhausts the ladder and reports ErrLLMUnavailable, which is the
// signal FallbackLLMClient watches for to try the next provider.
func TestOpenAICompatibleRetriesThenReportsUnavailable(t *testing.T) {
	zeroBackoffs(t)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	client, _ := NewOpenAICompatibleClient(OpenAICompatibleConfig{
		Name: "vllm", BaseURL: srv.URL + "/v1", Model: "m", HTTPClient: srv.Client(),
	})
	_, err := client.Generate(context.Background(), "p")
	if !errors.Is(err, ErrLLMUnavailable) {
		t.Fatalf("err = %v, want ErrLLMUnavailable", err)
	}
	if calls != len(llmRetryBackoffs) {
		t.Errorf("attempts = %d, want %d", calls, len(llmRetryBackoffs))
	}
	if !strings.Contains(err.Error(), "vllm") {
		t.Errorf("error should name the provider: %v", err)
	}
}

// A 4xx is permanent: fail on the first attempt and surface the body.
func TestOpenAICompatibleSurfacesPermanentError(t *testing.T) {
	zeroBackoffs(t)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":{"message":"model \"ghost\" not found"}}`)
	}))
	defer srv.Close()

	client, _ := NewOpenAICompatibleClient(OpenAICompatibleConfig{
		BaseURL: srv.URL + "/v1", Model: "ghost", HTTPClient: srv.Client(),
	})
	_, err := client.Generate(context.Background(), "p")
	if err == nil {
		t.Fatal("want error")
	}
	if errors.Is(err, ErrLLMUnavailable) {
		t.Error("permanent failure should not report as unavailable")
	}
	if calls != 1 {
		t.Errorf("attempts = %d, want 1 (no retry on 4xx)", calls)
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("body not surfaced: %v", err)
	}
}

// Some gateways answer 200 with an error object instead of an HTTP code.
func TestOpenAICompatibleErrorObjectOn200(t *testing.T) {
	zeroBackoffs(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"error":{"message":"context length exceeded"}}`)
	}))
	defer srv.Close()

	client, _ := NewOpenAICompatibleClient(OpenAICompatibleConfig{
		BaseURL: srv.URL + "/v1", Model: "m", HTTPClient: srv.Client(),
	})
	_, err := client.Generate(context.Background(), "p")
	if err == nil || !strings.Contains(err.Error(), "context length exceeded") {
		t.Errorf("err = %v, want the gateway's message", err)
	}
}

func TestOpenAICompatibleEmptyChoices(t *testing.T) {
	zeroBackoffs(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"choices":[]}`)
	}))
	defer srv.Close()

	client, _ := NewOpenAICompatibleClient(OpenAICompatibleConfig{
		Name: "ollama", BaseURL: srv.URL + "/v1", Model: "m", HTTPClient: srv.Client(),
	})
	if _, err := client.Generate(context.Background(), "p"); err == nil {
		t.Error("want error on empty choices")
	}
}

// The hosted OpenAI client is now a preconfigured compatible client; it
// must still short-circuit when no key is set rather than spend retries.
func TestOpenAIClientRequiresKey(t *testing.T) {
	zeroBackoffs(t)
	client := NewOpenAIClient("", "", http.DefaultClient)
	if _, err := client.Generate(context.Background(), "p"); err == nil {
		t.Fatal("want error when API key is unset")
	}
	if client.model != DefaultOpenAIModel {
		t.Errorf("model = %q, want %q", client.model, DefaultOpenAIModel)
	}
	if client.baseURL != openAIBaseURL+chatCompletionsPath {
		t.Errorf("baseURL = %q", client.baseURL)
	}
}
