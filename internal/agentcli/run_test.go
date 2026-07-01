package agentcli

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestCommandsJSONIncludesAgentGuidance(t *testing.T) {
	var stdout bytes.Buffer
	code := Execute([]string{"commands", "show", "roast", "--json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}

	var payload CommandInfo
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Name != "roast" {
		t.Fatalf("expected roast command, got %q", payload.Name)
	}
	if payload.AgentGuidance == "" || payload.ResponseSemantics == "" {
		t.Fatalf("expected agent guidance and response semantics in catalog")
	}
}

func TestAuthStatusDoesNotContactServer(t *testing.T) {
	var stdout bytes.Buffer
	code := Execute([]string{"auth", "status", "--json"}, &stdout, &bytes.Buffer{})
	if code != 0 {
		t.Fatalf("Execute returned %d", code)
	}

	var payload map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["host"] != DefaultHost {
		t.Fatalf("expected default host %q, got %v", DefaultHost, payload["host"])
	}
}
