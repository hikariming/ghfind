package backend

import (
	"context"
	"sort"
	"strings"
)

const maxOrganizationMaintainedRepos = 6

// collectOrganizationMaintainedRepos finds a narrow set of public
// organization-owned repositories that the scanned user demonstrably
// maintains. It deliberately has no score side effects: callers persist its
// result only in SignatureWork for profile/prompt presentation.
//
// A public organization membership is useful but not required here: members
// may hide it on GitHub. Instead, a candidate needs the existing long-term
// contribution threshold plus repository-local proof (a release/tag author or
// an explicit maintainer/CODEOWNERS entry). This prevents mere contributors
// from inheriting a whole organization's repository portfolio.
func (c *GitHubClient) collectOrganizationMaintainedRepos(ctx context.Context, contributions []ContribRepoAgg, loginLower string, profileURL *string) []OrganizationMaintainedRepo {
	candidates := make([]ContribRepoAgg, 0)
	for _, contribution := range contributions {
		if contribution.IsPrivate || contribution.IsFork || strings.EqualFold(contribution.OwnerLogin, loginLower) || !hasStrongLongTermOrgContribution(contribution) {
			continue
		}
		candidates = append(candidates, contribution)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		iWork := candidates[i].Commits + candidates[i].PRs*4
		jWork := candidates[j].Commits + candidates[j].PRs*4
		return iWork > jWork || (iWork == jWork && candidates[i].Stars > candidates[j].Stars)
	})
	if len(candidates) > maxOrganizationMaintainedRepos {
		candidates = candidates[:maxOrganizationMaintainedRepos]
	}

	result := make([]OrganizationMaintainedRepo, 0, len(candidates))
	for _, candidate := range candidates {
		owner, name, found := strings.Cut(candidate.Repo, "/")
		if !found || owner == "" || name == "" {
			continue
		}
		detail, err := c.fetchRepoDetails(ctx, owner, name)
		if err != nil || detail == nil || detail.Private || detail.Fork || detail.Owner == nil || !strings.EqualFold(detail.Owner.Type, "Organization") {
			continue
		}
		releaseOrTagAuthor := c.hasReleaseOrTagAuthor(ctx, owner, name, loginLower)
		maintainerFileHit := c.hasMaintainerFileHit(ctx, owner, name, loginLower, profileURL)
		if !releaseOrTagAuthor && !maintainerFileHit {
			continue
		}
		evidence := []string{formatNumber(candidate.Commits) + " commits + " + formatNumber(candidate.PRs) + " PRs across " + formatNumber(candidate.ActiveYears) + " years"}
		if releaseOrTagAuthor {
			evidence = append(evidence, "release/tag author")
		}
		if maintainerFileHit {
			evidence = append(evidence, "listed in maintainer/codeowner docs")
		}
		repository := topRepoFromGitHub(*detail, owner, false, nil)
		if languages, languageErr := c.fetchRepoLanguages(ctx, owner, name); languageErr == nil {
			repository.Languages = languages
		}
		result = append(result, OrganizationMaintainedRepo{
			Repository:  repository,
			Commits:     candidate.Commits,
			PRs:         candidate.PRs,
			ActiveYears: candidate.ActiveYears,
			Evidence:    evidence,
		})
	}
	return result
}
