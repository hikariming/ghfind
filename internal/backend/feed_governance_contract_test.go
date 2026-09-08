package backend

import (
	"encoding/json"
	"os"
	"testing"
)

func TestFeedGovernanceCanonicalDigestMatchesECMAScript(t *testing.T) {
	b, err := os.ReadFile("testdata/feed_governance_digest.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Input  FeedGovernanceReview `json:"input"`
		SHA256 string               `json:"sha256"`
	}
	if err = json.Unmarshal(b, &fixture); err != nil {
		t.Fatal(err)
	}
	if err := validateGovReview(fixture.Input); err != nil {
		t.Fatal("invalid shared fixture", err)
	}
	got, err := feedGovernanceDigest(fixture.Input, "")
	if err != nil || got != fixture.SHA256 {
		t.Fatalf("digest=%s want=%s err=%v", got, fixture.SHA256, err)
	}
}
