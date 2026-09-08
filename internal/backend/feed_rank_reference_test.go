package backend

// Frozen pre-optimization algorithm from 5a3333d. Test-only oracle: compare
// complete private output under the same math implementation on each platform.
// Never call this cubic implementation from production.
import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	mathrand "math/rand"
	"sort"
	"strings"
	"time"
)

func referenceRankFeedCandidates(candidates []FeedCandidate, options FeedRankOptions) []FeedRankedItem {
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
		if options.ExplorationWindowSize > 0 {
			explorationCount = 0
			for _, prior := range result[maxInt(0, len(result)-options.ExplorationWindowSize+1):] {
				if prior.Exploration {
					explorationCount++
				}
			}
		} else if len(result) > 0 && len(result)%options.ExplorationPageSize == 0 {
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
