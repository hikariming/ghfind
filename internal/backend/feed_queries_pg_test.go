package backend

import (
	"crypto/sha256"
	"fmt"
	"testing"
)

// Captured from the runtime SQL at 1bc35c3 before moving the literals. These
// fingerprints prevent diagnostics refactoring from changing serving SQL.
func TestFeedDiagnosticQueriesPreserveRuntimeSQL(t *testing.T) {
	expected := map[string]string{
		"candidates.tag":       "bfc6027e4092aebfc544cb657490738bf41cbd19138a18b327e24bd4075103e5",
		"candidates.hydrate":   "01e6eef66d5fcc4b78cd84849d23cc0bd428ebf0c3e3d9010c2df40a88c73508",
		"candidates.tags":      "ff67c0db32ad136f1586527be72f4615ca202acdae9d77909c1a9cfd5a50f757",
		"snapshot.available":   "17736ccfa0a7eacec226ae23bd0801b06c05f6537774f365145d6a5cb596d094",
		"snapshot.eligible":    "ab0b3c734c1a2d52a1b1bfddee0ec04abafd12f032cf920e3ccf8fe4ecfc4056",
		"candidates.latest":    "fa9032cb2e0262e3537783e85569a94e08471523c31989a7a684cebde71c4ed0",
		"candidates.quality":   "71cf719c3f7052f64ff6e0ba9e08ee9182e982ca739b50e2990476fe02efd13e",
		"candidates.discovery": "6145da3e19573e9e7d60dddf3c774d73f9706acaa5f04077921a06e5b5e20fc0",
	}
	for name, query := range feedDiagnosticReadQueries() {
		if got := fmt.Sprintf("%x", sha256.Sum256([]byte(query))); got != expected[name] {
			t.Fatalf("%s SQL changed: %s", name, got)
		}
		if got, ok := FeedDiagnosticReadQuery(query); !ok || got != name {
			t.Fatalf("unregistered %s", name)
		}
	}
}
