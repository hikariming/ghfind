package feedmigration

import (
	"os"
	"reflect"
	"regexp"
	"sort"
	"testing"
)

// The approved baseline is shared with D1. This guards against introducing
// PostgreSQL-only canonical labels while preserving later reviewed taxonomy.
func TestSeedTaxonomyMatchesApprovedD1Baseline(t *testing.T) {
	pg, err := migrations.ReadFile("migrations/0002_seed_taxonomy.sql")
	if err != nil {
		t.Fatal(err)
	}
	d1, err := os.ReadFile("../../migrations-feed/0001_feed_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	pattern := regexp.MustCompile(`(?m)^\s*\('([^']+)'`)
	ids := func(data []byte) []string {
		result := []string{}
		for _, match := range pattern.FindAllSubmatch(data, -1) {
			result = append(result, string(match[1]))
		}
		sort.Strings(result)
		return result
	}
	a, b := ids(pg), ids(d1)
	if len(a) != 13 || !reflect.DeepEqual(a, b) {
		t.Fatalf("canonical seed disagreement PostgreSQL=%v D1=%v", a, b)
	}
}
