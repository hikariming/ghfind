package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

type scoreFixture struct {
	Input    RawMetrics `json:"input"`
	Expected Scoring    `json:"expected"`
}

func TestScoreMatchesCanonicalNodeFixtures(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate Go test file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "src", "lib", "__tests__", "score-fixtures.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read canonical Node scoring fixtures: %v", err)
	}
	fixtures := map[string]scoreFixture{}
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatalf("decode canonical Node scoring fixtures: %v", err)
	}
	for name, fixture := range fixtures {
		t.Run(name, func(t *testing.T) {
			if got := Score(fixture.Input); !reflect.DeepEqual(got, fixture.Expected) {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(fixture.Expected, "", "  ")
				t.Fatalf("score mismatch\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
		})
	}
}

func TestRoundToEvenMatchesPublishedBoundaryRule(t *testing.T) {
	for _, test := range []struct {
		value  float64
		digits int
		want   float64
	}{
		{17.25, 1, 17.2},
		{17.35, 1, 17.4},
		{34.205, 2, 34.2},
		{34.215, 2, 34.22},
	} {
		if got := roundToEven(test.value, test.digits); got != test.want {
			t.Errorf("roundToEven(%v, %d) = %v, want %v", test.value, test.digits, got, test.want)
		}
	}
}

// The shared Upstash scan cache is read by both runtimes, and the Node scorer
// distinguishes `undefined` (unmeasured) from `null` (a real value). Go must
// omit optional metric keys when they are nil, keep explicit nulls for fields
// typed `| null` on the Node side, and never serialize required arrays as
// null.
func TestScanResultJSONHonorsNodeNullSemantics(t *testing.T) {
	scan := ScanResult{
		Metrics:       RawMetrics{Username: "alice"},
		TopRepos:      []TopRepo{},
		RecentPRs:     []RecentPR{},
		FloodPRTitles: []string{},
	}
	encoded, err := json.Marshal(scan)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	metrics, ok := payload["metrics"].(map[string]any)
	if !ok {
		t.Fatalf("metrics missing in %s", encoded)
	}
	for _, optional := range []string{
		"top_repo_engagement_ratio", "impact_quality_cap",
		"maintainer_closed_unmerged_pr_count", "self_closed_external_pr_count",
		"self_closed_own_repo_pr_count", "recent_doc_like_pr_count",
		"recent_external_doc_like_pr_count", "workflow_landed_pr_count",
	} {
		if _, present := metrics[optional]; present {
			t.Errorf("optional metric %q must be omitted when nil, got %v", optional, metrics[optional])
		}
	}
	for _, nullable := range []string{"profile_url", "avatar_url", "name", "days_since_last_activity", "top_repo_pr_target"} {
		value, present := metrics[nullable]
		if !present || value != nil {
			t.Errorf("nullable metric %q must be present as explicit null, present=%v value=%v", nullable, present, value)
		}
	}
	for _, array := range []string{"top_repos", "recent_prs", "flood_pr_titles"} {
		value, present := payload[array]
		if !present {
			t.Errorf("required array %q missing", array)
			continue
		}
		if _, isArray := value.([]any); !isArray {
			t.Errorf("required array %q serialized as %T, want JSON array", array, value)
		}
	}
}
