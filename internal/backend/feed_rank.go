package backend

import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	mathrand "math/rand"
	"sort"
	"strings"
	"time"
)

const (
	feedMMRLambda              = 0.78
	feedExplorationRate        = 0.10
	feedExplorationTemperature = 0.15
	feedMaxExplorationPerPage  = 2
)

type FeedRankOptions struct {
	Now                 time.Time
	Limit               int
	Seed                string
	MMRLambda           float64
	ExplorationRate     float64
	MaxExploration      int
	ExplorationPageSize int
	OwnerCap            int
}

type scoredFeedCandidate struct {
	candidate FeedCandidate
	score     float64
	features  FeedFeatureSnapshot
}

type feedRankedIndex struct {
	index int
	mmr   float64
}

func RankFeedCandidates(candidates []FeedCandidate, options FeedRankOptions) []FeedRankedItem {
	if options.Now.IsZero() {
		options.Now = time.Now().UTC()
	}
	if options.Limit < 1 {
		options.Limit = 20
	}
	if options.Limit > 240 {
		options.Limit = 240
	}
	if options.MMRLambda <= 0 || options.MMRLambda > 1 {
		options.MMRLambda = feedMMRLambda
	}
	if options.ExplorationRate < 0 || options.ExplorationRate > 1 {
		options.ExplorationRate = feedExplorationRate
	}
	if options.MaxExploration < 0 {
		options.MaxExploration = 0
	} else if options.MaxExploration == 0 {
		options.MaxExploration = feedMaxExplorationPerPage
	}
	if options.ExplorationPageSize < 1 {
		options.ExplorationPageSize = 20
	}
	if options.OwnerCap < 1 {
		options.OwnerCap = maxInt(2, int(math.Ceil(float64(options.Limit)/10)))
	}

	unique := map[string]scoredFeedCandidate{}
	recentFallback := map[string]scoredFeedCandidate{}
	for _, candidate := range candidates {
		key := strings.ToLower(strings.TrimSpace(candidate.Project.RepoKey))
		if key == "" || !candidate.Project.Publishable || candidate.NotInterested {
			continue
		}
		recent := false
		if candidate.SeenAt != nil {
			age := options.Now.Sub(*candidate.SeenAt)
			if age < 7*24*time.Hour {
				continue
			}
			recent = age < 30*24*time.Hour
		}
		score, features := baselineFeedScore(candidate, options.Now)
		candidate.Project.RepoKey = key
		candidate.Sources = uniqueStrings(candidate.Sources)
		target := unique
		if recent {
			target = recentFallback
		}
		current, exists := target[key]
		if !exists || score > current.score {
			target[key] = scoredFeedCandidate{candidate: candidate, score: score, features: features}
		}
	}
	remaining := make([]scoredFeedCandidate, 0, len(unique))
	for _, candidate := range unique {
		remaining = append(remaining, candidate)
	}
	// A 7-30 day impression is only reintroduced when the default 30-day
	// exclusion would leave the requested page short.
	if len(remaining) < options.Limit {
		for key, candidate := range recentFallback {
			if _, exists := unique[key]; !exists {
				remaining = append(remaining, candidate)
			}
		}
	}
	sort.SliceStable(remaining, func(i, j int) bool {
		if remaining[i].score != remaining[j].score {
			return remaining[i].score > remaining[j].score
		}
		return remaining[i].candidate.Project.RepoKey < remaining[j].candidate.Project.RepoKey
	})

	digest := sha256.Sum256([]byte(options.Seed))
	rng := mathrand.New(mathrand.NewSource(int64(binary.BigEndian.Uint64(digest[:8])))) //nolint:gosec
	selected := make([]scoredFeedCandidate, 0, minInt(options.Limit, len(remaining)))
	result := make([]FeedRankedItem, 0, minInt(options.Limit, len(remaining)))
	explorationCount := 0
	for len(remaining) > 0 && len(result) < options.Limit {
		if len(result) > 0 && len(result)%options.ExplorationPageSize == 0 {
			explorationCount = 0
		}
		available := make([]feedRankedIndex, 0, len(remaining))
		for index := range remaining {
			owner := strings.ToLower(remaining[index].candidate.Project.OwnerLogin)
			ownerCount := 0
			windowStart := maxInt(0, len(result)-19)
			for _, served := range result[windowStart:] {
				if strings.EqualFold(served.Project.OwnerLogin, owner) {
					ownerCount++
				}
			}
			if ownerCount >= options.OwnerCap {
				continue
			}
			maxSimilarity := 0.0
			for _, prior := range selected {
				maxSimilarity = math.Max(maxSimilarity, feedCandidateSimilarity(remaining[index].candidate, prior.candidate))
			}
			mmr := options.MMRLambda*remaining[index].score - (1-options.MMRLambda)*maxSimilarity
			available = append(available, feedRankedIndex{index: index, mmr: mmr})
		}
		if len(available) == 0 {
			break
		}
		sort.SliceStable(available, func(i, j int) bool {
			if available[i].mmr != available[j].mmr {
				return available[i].mmr > available[j].mmr
			}
			return remaining[available[i].index].candidate.Project.RepoKey < remaining[available[j].index].candidate.Project.RepoKey
		})
		poolSize := minInt(50, len(available))
		probabilities := softmaxMMR(available[:poolSize])
		chosenPool := 0
		exploration := false
		canExplore := explorationCount < options.MaxExploration && options.ExplorationRate > 0
		if canExplore && rng.Float64() < options.ExplorationRate {
			chosenPool = sampleProbability(rng.Float64(), probabilities)
			exploration = true
			explorationCount++
		}
		chosen := available[chosenPool]
		propensity := 1.0
		if canExplore {
			propensity = options.ExplorationRate * probabilities[chosenPool]
			if chosenPool == 0 {
				propensity += 1 - options.ExplorationRate
			}
		}
		item := remaining[chosen.index]
		item.features.MMRScore = chosen.mmr
		result = append(result, FeedRankedItem{
			Project: item.candidate.Project, CandidateSources: item.candidate.Sources,
			ReasonCodes: feedReasonCodes(item.candidate, item.features, exploration),
			Score:       item.score, Rank: len(result), Exploration: exploration, Propensity: clamp01Positive(propensity), Features: item.features,
		})
		selected = append(selected, item)
		remaining = append(remaining[:chosen.index], remaining[chosen.index+1:]...)
	}
	return result
}

func baselineFeedScore(candidate FeedCandidate, now time.Time) (float64, FeedFeatureSnapshot) {
	features := FeedFeatureSnapshot{
		TagAffinity: candidate.TagAffinity, SemanticSimilarity: candidate.SemanticSimilarity,
		ProductScore:   clamp01(candidate.Project.ProductScore / 100),
		Confidence:     clamp01(candidate.Project.Confidence / 100),
		Freshness:      math.Exp(-math.Max(0, now.Sub(candidate.Project.AnalyzedAt).Hours()/24) / 90),
		DiscoveryBoost: feedDiscoveryBoost(candidate.Project.ExposureBand),
	}
	type signal struct {
		value, weight float64
		present       bool
	}
	signals := []signal{
		{weight: .38, present: candidate.TagAffinity != nil},
		{weight: .30, present: candidate.SemanticSimilarity != nil},
		{value: features.ProductScore, weight: .14, present: true},
		{value: features.Confidence, weight: .06, present: true},
		{value: features.Freshness, weight: .06, present: true},
		{value: features.DiscoveryBoost, weight: .06, present: true},
	}
	if candidate.TagAffinity != nil {
		signals[0].value = clamp01((*candidate.TagAffinity + 1) / 2)
	}
	if candidate.SemanticSimilarity != nil {
		signals[1].value = clamp01((*candidate.SemanticSimilarity + 1) / 2)
	}
	total, weights := 0.0, 0.0
	for _, signal := range signals {
		if signal.present {
			total += signal.value * signal.weight
			weights += signal.weight
		}
	}
	if weights == 0 {
		return 0, features
	}
	return clamp01(total / weights), features
}

func feedDiscoveryBoost(band string) float64 {
	switch strings.ToLower(strings.TrimSpace(band)) {
	case "low":
		return 1
	case "emerging":
		return .75
	case "unknown":
		return .25
	case "established":
		return .15
	default:
		return 0
	}
}

func feedCandidateSimilarity(left, right FeedCandidate) float64 {
	semantic := cosineSimilarity(left.Embedding, right.Embedding)
	tags := weightedTagJaccard(left.Project.Tags, right.Project.Tags)
	return math.Max(semantic, tags)
}

func weightedTagJaccard(left, right []FeedTag) float64 {
	l, r := map[string]float64{}, map[string]float64{}
	for _, tag := range left {
		l[tag.ID] = math.Max(l[tag.ID], tag.Weight)
	}
	for _, tag := range right {
		r[tag.ID] = math.Max(r[tag.ID], tag.Weight)
	}
	union := map[string]bool{}
	for key := range l {
		union[key] = true
	}
	for key := range r {
		union[key] = true
	}
	intersection, total := 0.0, 0.0
	for key := range union {
		intersection += math.Min(l[key], r[key])
		total += math.Max(l[key], r[key])
	}
	if total == 0 {
		return 0
	}
	return intersection / total
}

func cosineSimilarity(left, right []float64) float64 {
	if len(left) == 0 || len(left) != len(right) {
		return 0
	}
	dot, leftNorm, rightNorm := 0.0, 0.0, 0.0
	for index := range left {
		dot += left[index] * right[index]
		leftNorm += left[index] * left[index]
		rightNorm += right[index] * right[index]
	}
	if leftNorm == 0 || rightNorm == 0 {
		return 0
	}
	return clampRange(dot/math.Sqrt(leftNorm*rightNorm), -1, 1)
}

func softmaxMMR(items []feedRankedIndex) []float64 {
	if len(items) == 0 {
		return nil
	}
	maxScore := items[0].mmr
	weights, total := make([]float64, len(items)), 0.0
	for index, item := range items {
		weights[index] = math.Exp((item.mmr - maxScore) / feedExplorationTemperature)
		total += weights[index]
	}
	for index := range weights {
		weights[index] /= total
	}
	return weights
}

func sampleProbability(value float64, probabilities []float64) int {
	cumulative := 0.0
	for index, probability := range probabilities {
		cumulative += probability
		if value <= cumulative {
			return index
		}
	}
	return maxInt(0, len(probabilities)-1)
}

func feedReasonCodes(candidate FeedCandidate, features FeedFeatureSnapshot, exploration bool) []string {
	reasons := []string{}
	if candidate.TagAffinity != nil && *candidate.TagAffinity >= .2 {
		reasons = append(reasons, "matches_tags")
	}
	if candidate.SemanticSimilarity != nil && *candidate.SemanticSimilarity >= .55 {
		reasons = append(reasons, "similar_to_saved")
	}
	if features.ProductScore >= .75 {
		reasons = append(reasons, "high_product_value")
	}
	if features.Freshness >= .80 {
		reasons = append(reasons, "newly_evaluated")
	}
	if features.DiscoveryBoost >= .75 || exploration {
		reasons = append(reasons, "long_tail_discovery")
	}
	if len(reasons) == 0 {
		reasons = append(reasons, "catalog_discovery")
	}
	return uniqueStrings(reasons)
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result
}

func clamp01(value float64) float64 { return clampRange(value, 0, 1) }
func clampRange(value, minimum, maximum float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return minimum
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
func clamp01Positive(value float64) float64 {
	value = clamp01(value)
	if value == 0 {
		return math.SmallestNonzeroFloat64
	}
	return value
}
