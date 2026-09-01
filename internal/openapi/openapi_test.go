package openapi

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestSpecValidates confirms the embedded YAML parses and round-trips to
// valid JSON with the shape external tooling expects. init() would have
// already panicked on a malformed YAML input — this test nails down the
// post-init invariants (structure, required fields, a sample of paths).
func TestSpecValidates(t *testing.T) {
	if len(SpecYAML()) == 0 {
		t.Fatal("SpecYAML is empty — embed likely broken")
	}
	if len(SpecJSON()) == 0 {
		t.Fatal("SpecJSON is empty — init() did not populate")
	}

	var doc map[string]any
	if err := json.Unmarshal(SpecJSON(), &doc); err != nil {
		t.Fatalf("SpecJSON is not valid JSON: %v", err)
	}

	// Top-level OpenAPI 3.1 shape.
	if v, _ := doc["openapi"].(string); !strings.HasPrefix(v, "3.") {
		t.Errorf("unexpected openapi version: %v", doc["openapi"])
	}

	info, _ := doc["info"].(map[string]any)
	if info == nil || info["title"] == "" {
		t.Error("info.title missing")
	}

	paths, _ := doc["paths"].(map[string]any)
	if paths == nil {
		t.Fatal("paths missing")
	}

	// A spot-check across the three auth tiers — if any of these drop
	// out of the spec, the YAML has drifted from the routing table.
	for _, want := range []string{"/history", "/ai-insight", "/me/api-keys"} {
		if _, ok := paths[want]; !ok {
			t.Errorf("paths missing %q", want)
		}
	}

	components, _ := doc["components"].(map[string]any)
	schemes, _ := components["securitySchemes"].(map[string]any)
	if _, ok := schemes["bearerApiKey"]; !ok {
		t.Error("bearerApiKey security scheme missing")
	}
}
