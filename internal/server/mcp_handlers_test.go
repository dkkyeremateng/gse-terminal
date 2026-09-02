package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/teckdroids/ges-data-engine/internal/auth"
	"github.com/teckdroids/ges-data-engine/internal/config"
)

func authenticatedMCPRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	ctx := context.WithValue(req.Context(), auth.UserIDKey, 7)
	ctx = context.WithValue(ctx, auth.UsernameKey, "market-user")
	ctx = context.WithValue(ctx, auth.RoleKey, "user")
	return req.WithContext(ctx)
}

func decodeMCPResponse(t *testing.T, rec *httptest.ResponseRecorder) mcpResponse {
	t.Helper()
	var response mcpResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, rec.Body.String())
	}
	return response
}

func TestHandleMCPRejectsUnauthenticatedRequests(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Server{}).HandleMCP(rec, httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestHandleMCPProtocol(t *testing.T) {
	server := &Server{}
	cases := []struct {
		name     string
		body     string
		wantCode int
		wantErr  int
	}{
		{"initialize", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"test","version":"1"}}}`, http.StatusOK, 0},
		{"unsupported protocol", `{"jsonrpc":"2.0","id":11,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`, http.StatusOK, -32602},
		{"missing initialize version", `{"jsonrpc":"2.0","id":12,"method":"initialize","params":{}}`, http.StatusOK, -32602},
		{"envelope extensions allowed", `{"jsonrpc":"2.0","id":13,"method":"ping","meta":{"trace":"abc"}}`, http.StatusOK, 0},
		{"tools list", `{"jsonrpc":"2.0","id":"tools","method":"tools/list","params":{}}`, http.StatusOK, 0},
		{"ping", `{"jsonrpc":"2.0","id":2,"method":"ping"}`, http.StatusOK, 0},
		{"unknown method", `{"jsonrpc":"2.0","id":3,"method":"nope"}`, http.StatusOK, -32601},
		{"wrong version", `{"jsonrpc":"1.0","id":4,"method":"ping"}`, http.StatusOK, -32600},
		{"invalid boolean id", `{"jsonrpc":"2.0","id":true,"method":"ping"}`, http.StatusOK, -32600},
		{"malformed JSON", `{`, http.StatusOK, -32700},
		{"multiple payloads", `{"jsonrpc":"2.0","id":5,"method":"ping"} {}`, http.StatusOK, -32600},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			server.HandleMCP(rec, authenticatedMCPRequest(tc.body))
			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantCode)
			}
			response := decodeMCPResponse(t, rec)
			if response.JSONRPC != "2.0" {
				t.Errorf("jsonrpc = %q", response.JSONRPC)
			}
			if tc.wantErr == 0 && response.Error != nil {
				t.Fatalf("unexpected error: %+v", response.Error)
			}
			if tc.wantErr != 0 && (response.Error == nil || response.Error.Code != tc.wantErr) {
				t.Fatalf("error = %+v, want code %d", response.Error, tc.wantErr)
			}
		})
	}
}

func TestHandleMCPToolsListHasStrictSchemas(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Server{}).HandleMCP(rec, authenticatedMCPRequest(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`))
	response := decodeMCPResponse(t, rec)
	result, ok := response.Result.(map[string]any)
	if !ok {
		t.Fatalf("result = %#v, want object", response.Result)
	}
	tools, ok := result["tools"].([]any)
	if !ok || len(tools) != len(mcpTools) {
		t.Fatalf("tools = %#v, want %d tools", result["tools"], len(mcpTools))
	}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		schema := tool["inputSchema"].(map[string]any)
		if schema["additionalProperties"] != false {
			t.Errorf("tool %s permits unknown arguments", tool["name"])
		}
	}
}

func TestHandleMCPOriginValidation(t *testing.T) {
	server := &Server{cfg: &config.Config{AllowedOrigins: []string{"https://terminal.example"}}}
	body := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	for _, tc := range []struct {
		name   string
		origin string
		want   int
	}{
		{"non-browser client", "", http.StatusOK},
		{"allowed browser", "https://terminal.example", http.StatusOK},
		{"rejected origin", "https://evil.example", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := authenticatedMCPRequest(body)
			req.Header.Set("Origin", tc.origin)
			rec := httptest.NewRecorder()
			server.HandleMCP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestHandleMCPNotificationsHaveNoBody(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Server{}).HandleMCP(rec, authenticatedMCPRequest(`{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusAccepted)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("notification returned a body: %q", rec.Body.String())
	}
}

func TestMCPToolValidationAndAuthorization(t *testing.T) {
	server := &Server{}
	request := authenticatedMCPRequest(`{}`)
	basic := &auth.User{ID: 1, Username: "basic", Role: "user"}
	pro := &auth.User{ID: 2, Username: "pro", Role: "pro"}

	cases := []struct {
		name string
		call mcpToolCall
		user *auth.User
		want string
	}{
		{"unknown tool", mcpToolCall{Name: "drop_database", Arguments: json.RawMessage(`{}`)}, basic, "unknown tool"},
		{"unknown argument rejected", mcpToolCall{Name: "get_latest_quote", Arguments: json.RawMessage(`{"symbol":"MTNGH","sql":"SELECT *"}`)}, basic, "symbol is required"},
		{"technical tool requires pro", mcpToolCall{Name: "get_technical_indicators", Arguments: json.RawMessage(`{"symbol":"MTNGH"}`)}, basic, "Pro or Admin access required"},
		{"technical pro dependency failure is safe", mcpToolCall{Name: "get_technical_indicators", Arguments: json.RawMessage(`{"symbol":"MTNGH"}`)}, pro, "market data is temporarily unavailable"},
		{"history caps limit before database work", mcpToolCall{Name: "get_price_history", Arguments: json.RawMessage(`{"symbol":"MTNGH","limit":2001}`)}, basic, "limit must be between 1 and 2000"},
		{"briefing rejects null arguments", mcpToolCall{Name: "get_market_briefing", Arguments: json.RawMessage(`null`)}, basic, "this tool takes no arguments"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := server.callMCPTool(request, tc.call, tc.user)
			if !result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, tc.want) {
				t.Fatalf("result = %+v, want error containing %q", result, tc.want)
			}
		})
	}
}

func TestEmptyMCPArguments(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{"", true}, {"{}", true}, {"{ }", true}, {"null", false}, {"[]", false}, {`{"unexpected":true}`, false},
	} {
		if got := emptyMCPArguments(json.RawMessage(tc.raw)); got != tc.want {
			t.Errorf("emptyMCPArguments(%q) = %v, want %v", tc.raw, got, tc.want)
		}
	}
}

func TestDecodeMCPParamsRejectsUnknownAndTrailingFields(t *testing.T) {
	var args struct {
		Symbol string `json:"symbol"`
	}
	if decodeMCPParams(json.RawMessage(`{"symbol":"MTNGH","extra":true}`), &args) {
		t.Fatal("unknown parameter was accepted")
	}
	if decodeMCPParams(json.RawMessage(`{"symbol":"MTNGH"} {}`), &args) {
		t.Fatal("trailing JSON value was accepted")
	}
	if !decodeMCPParams(json.RawMessage(`{"symbol":"MTNGH"}`), &args) || args.Symbol != "MTNGH" {
		t.Fatal("valid parameters were rejected")
	}
}

func TestMCPSuccessResultPreservesStructuredData(t *testing.T) {
	result := mcpSuccessResult(map[string]any{"symbol": "MTNGH"})
	if result.IsError || len(result.Content) != 1 || !bytes.Contains([]byte(result.Content[0].Text), []byte("MTNGH")) {
		t.Fatalf("unexpected result: %+v", result)
	}
}
