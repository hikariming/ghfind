package scoring

import "math"

// Rating ladder: 30–100 with one rating every 10 points; scores below 30 share
// the entry rating. Lv.N is floor(score) clamped to 1…100. Mirrors
// src/rating.ts; fixtures/rating-ladder.json pins TypeScript, Go and Python.

type RatingStep struct {
	ID       string  `json:"id"`
	MinScore float64 `json:"minScore"`
	Rank     int     `json:"rank"`
}

const (
	RatingFloor     = 30.0
	RatingStepWidth = 10.0
)

var RatingLadder = []RatingStep{
	{"qi", 0, 1},
	{"foundation", 30, 2},
	{"goldenCore", 40, 3},
	{"nascentSoul", 50, 4},
	{"deity", 60, 5},
	{"voidRefining", 70, 6},
	{"integration", 80, 7},
	{"mahayana", 90, 8},
}

// RatingLevel is floor(score) clamped to 1…100; non-finite input is Lv.1.
func RatingLevel(score float64) int {
	if math.IsNaN(score) || math.IsInf(score, 0) {
		return 1
	}
	return int(math.Min(100, math.Max(1, math.Floor(score))))
}

// RatingForScore returns the step a score belongs to (threshold inclusive).
func RatingForScore(score float64) RatingStep {
	if math.IsNaN(score) || math.IsInf(score, 0) {
		score = 0
	}
	current := RatingLadder[0]
	for _, step := range RatingLadder {
		if score >= step.MinScore {
			current = step
		}
	}
	return current
}

// NextRating returns the next step and true, or false at the top.
func NextRating(score float64) (RatingStep, bool) {
	current := RatingForScore(score)
	for i, step := range RatingLadder {
		if step.ID == current.ID && i+1 < len(RatingLadder) {
			return RatingLadder[i+1], true
		}
	}
	return RatingStep{}, false
}
