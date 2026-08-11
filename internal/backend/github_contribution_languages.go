package backend

import (
	"context"
	"math"
	"sort"
	"strings"
)

const maxContributionLanguageRepos = 50

// collectEstimatedContributionLanguages estimates the languages a developer
// actually works in from their public commit and landed-PR contribution map.
//
// It intentionally reads the existing, score-bearing contribution aggregation
// without changing its scope, limits, or contents. The result is a
// presentation-only side channel: repository language bytes describe the
// repository, while log-scaled user contribution units decide how much that
// repository influences the language estimate.
func (c *GitHubClient) collectEstimatedContributionLanguages(ctx context.Context, contributions []ContribRepoAgg) *EstimatedContributionLanguages {
	candidates := make([]ContribRepoAgg, 0, len(contributions))
	for _, contribution := range contributions {
		if contribution.Repo == "" || contribution.IsPrivate || contribution.IsFork || contributionLanguageWorkUnits(contribution) <= 0 {
			continue
		}
		candidates = append(candidates, contribution)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		iWork, jWork := contributionLanguageWorkUnits(candidates[i]), contributionLanguageWorkUnits(candidates[j])
		if iWork != jWork {
			return iWork > jWork
		}
		if candidates[i].Commits != candidates[j].Commits {
			return candidates[i].Commits > candidates[j].Commits
		}
		if candidates[i].PRs != candidates[j].PRs {
			return candidates[i].PRs > candidates[j].PRs
		}
		return strings.ToLower(candidates[i].Repo) < strings.ToLower(candidates[j].Repo)
	})

	result := &EstimatedContributionLanguages{CandidateRepoCount: len(candidates)}
	if len(candidates) > maxContributionLanguageRepos {
		candidates = candidates[:maxContributionLanguageRepos]
	}
	result.SelectedRepoCount = len(candidates)

	weights := map[string]float64{}
	for _, candidate := range candidates {
		owner, name, found := strings.Cut(candidate.Repo, "/")
		if !found || owner == "" || name == "" {
			continue
		}
		languages, err := c.fetchRepoLanguages(ctx, owner, name)
		if err != nil {
			continue // Language display must never fail or alter a scored scan.
		}
		languageBytes := 0.0
		for _, language := range languages {
			if language.Size > 0 {
				languageBytes += language.Size
			}
		}
		if languageBytes == 0 {
			continue
		}
		repoWeight := math.Log1p(contributionLanguageWorkUnits(candidate))
		for _, language := range languages {
			if language.Name == "" || language.Size <= 0 {
				continue
			}
			weights[language.Name] += repoWeight * language.Size / languageBytes
		}
		result.SampledRepoCount++
	}

	totalWeight := 0.0
	for _, weight := range weights {
		totalWeight += weight
	}
	if totalWeight == 0 {
		return nil
	}
	type languageWeight struct {
		name   string
		weight float64
	}
	orderedWeights := make([]languageWeight, 0, len(weights))
	for name, weight := range weights {
		orderedWeights = append(orderedWeights, languageWeight{name: name, weight: weight})
	}
	sort.SliceStable(orderedWeights, func(i, j int) bool {
		if orderedWeights[i].weight != orderedWeights[j].weight {
			return orderedWeights[i].weight > orderedWeights[j].weight
		}
		return orderedWeights[i].name < orderedWeights[j].name
	})
	result.Languages = make([]EstimatedContributionLanguage, 0, len(orderedWeights))
	for _, language := range orderedWeights {
		result.Languages = append(result.Languages, EstimatedContributionLanguage{
			Name: language.name,
			Pct:  roundJS(language.weight / totalWeight * 100),
		})
	}
	return result
}

func contributionLanguageWorkUnits(contribution ContribRepoAgg) float64 {
	return max(0, contribution.Commits) + max(0, contribution.PRs)*4
}
