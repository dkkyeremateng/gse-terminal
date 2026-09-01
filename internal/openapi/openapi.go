// Package openapi embeds the /v1 OpenAPI 3.1 specification and serves it
// over HTTP. The spec is authored as YAML for readability, embedded into
// the binary at compile time, and parsed once at init() into an equivalent
// JSON representation so callers can fetch either format without any
// per-request conversion work.
package openapi

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"gopkg.in/yaml.v3"
)

//go:embed openapi.yaml
var specYAML []byte

// specJSON is the pre-converted JSON form. Populated once by init() and
// read-only afterwards — safe to share across goroutines without a lock.
var specJSON []byte

// lastModified is used for conditional requests. The spec is baked into
// the binary, so the binary's compile-time identity is the closest
// meaningful modification timestamp — but since that's hard to surface
// reliably, process start time is a sufficient proxy: any cache that
// survives a restart is a cache that has seen a potential deploy.
var lastModified = time.Now().UTC()

func init() {
	// Round-trip YAML → interface → JSON. yaml.v3 decodes map keys as
	// strings (our spec has no non-string keys), so the intermediate
	// representation is directly JSON-encodable.
	var doc any
	if err := yaml.Unmarshal(specYAML, &doc); err != nil {
		panic(fmt.Sprintf("openapi: embedded spec is not valid YAML: %v", err))
	}
	doc = normaliseForJSON(doc)

	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		panic(fmt.Sprintf("openapi: spec could not be re-encoded as JSON: %v", err))
	}
	specJSON = buf
}

// normaliseForJSON walks a yaml.Unmarshal'ed tree and converts any
// map[interface{}]interface{} nodes (which encoding/json cannot marshal)
// into map[string]interface{}. yaml.v3 normally decodes to the latter
// already, but this guards against older behaviour and future surprises.
func normaliseForJSON(v any) any {
	switch m := v.(type) {
	case map[any]any:
		out := make(map[string]any, len(m))
		for k, val := range m {
			out[fmt.Sprint(k)] = normaliseForJSON(val)
		}
		return out
	case map[string]any:
		for k, val := range m {
			m[k] = normaliseForJSON(val)
		}
		return m
	case []any:
		for i, val := range m {
			m[i] = normaliseForJSON(val)
		}
		return m
	default:
		return v
	}
}

// SpecJSON returns the spec in JSON form. The returned slice must not be
// mutated by the caller.
func SpecJSON() []byte { return specJSON }

// SpecYAML returns the spec in its authored YAML form. The returned slice
// must not be mutated by the caller.
func SpecYAML() []byte { return specYAML }

// HandleJSON serves the spec as application/json.
func HandleJSON(w http.ResponseWriter, r *http.Request) {
	serve(w, r, "application/json; charset=utf-8", specJSON)
}

// HandleYAML serves the spec as application/yaml.
func HandleYAML(w http.ResponseWriter, r *http.Request) {
	serve(w, r, "application/yaml; charset=utf-8", specYAML)
}

func serve(w http.ResponseWriter, r *http.Request, contentType string, body []byte) {
	// The spec is public API documentation; CORS-enable it so tooling
	// (Postman, Stoplight, generators) running from any origin can pull
	// it without a proxy.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Last-Modified", lastModified.Format(http.TimeFormat))

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	_, _ = w.Write(body)
}
