package scoring

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/hikariming/ghfind/scoring/fixtures"
)

func TestRatingLadderMatchesFixture(t *testing.T) {
	data, err := fixtures.FS.ReadFile("rating-ladder.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Ladder []RatingStep `json:"ladder"`
		Cases  []struct {
			Score         float64  `json:"score"`
			Level         int      `json:"level"`
			Rating        string   `json:"rating"`
			NextThreshold *float64 `json:"next_threshold"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fx); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(fx.Ladder, RatingLadder) {
		t.Fatalf("ladder drift:\n got %+v\nwant %+v", RatingLadder, fx.Ladder)
	}
	for _, c := range fx.Cases {
		if got := RatingLevel(c.Score); got != c.Level {
			t.Errorf("level(%v) = %d, want %d", c.Score, got, c.Level)
		}
		if got := RatingForScore(c.Score).ID; got != c.Rating {
			t.Errorf("rating(%v) = %s, want %s", c.Score, got, c.Rating)
		}
		next, ok := NextRating(c.Score)
		if (c.NextThreshold == nil) == ok || (ok && next.MinScore != *c.NextThreshold) {
			t.Errorf("next(%v) = %+v,%v want %v", c.Score, next, ok, c.NextThreshold)
		}
	}
	for _, s := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if RatingLevel(s) != 1 || RatingForScore(s).ID != "qi" {
			t.Errorf("non-finite %v must be Lv.1 qi", s)
		}
	}
}
