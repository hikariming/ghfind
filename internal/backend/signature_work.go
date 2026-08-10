package backend

import (
	"regexp"
	"sort"
	"strings"
)

type SignatureWorkCluster struct {
	Repo  string  `json:"repo"`
	Stars float64 `json:"stars"`
	// AllTimePRs and SubstantiveLowStarSignal only exist on
	// all_history_public_scan clusters. The Go collector has no all-history PR
	// fact source (it always builds recent_sample clusters), so it never fills
	// them; they are declared so pre-Go persisted snapshots round-trip, and
	// prompt builders must degrade on nil/false instead of inventing counts.
	AllTimePRs               *float64 `json:"all_time_prs,omitempty"`
	RecentMergedPRsInSample  *float64 `json:"recent_merged_prs_in_sample,omitempty"`
	QualityKeywordHits       float64  `json:"quality_keyword_hits"`
	Examples                 []string `json:"examples"`
	OrgContextRepo           *string  `json:"org_context_repo,omitempty"`
	OrgContextStars          *float64 `json:"org_context_stars,omitempty"`
	SubstantiveLowStarSignal bool     `json:"substantive_low_star_signal,omitempty"`
}

// OrganizationMaintainedRepo is display/prompt evidence for an organization
// repository where the scanned account has both substantial public work and a
// repository-local maintainer proof. It is intentionally kept out of
// TopRepos/RawMetrics: it must never alter the deterministic score until a
// separately versioned scoring policy explicitly opts into it.
type OrganizationMaintainedRepo struct {
	Repository  TopRepo  `json:"repository"`
	Commits     float64  `json:"commits"`
	PRs         float64  `json:"prs"`
	ActiveYears float64  `json:"active_years"`
	Evidence    []string `json:"evidence"`
}

// EstimatedContributionLanguage is one language's contribution-weighted share
// across public repositories. It is intentionally separate from RawMetrics:
// language presentation must never become a scoring signal implicitly.
type EstimatedContributionLanguage struct {
	Name string  `json:"name"`
	Pct  float64 `json:"pct"`
}

// EstimatedContributionLanguages records the bounded coverage behind the
// profile's language display. Candidate repos can be personal, organization,
// or third-party repositories; ownership does not affect the estimate.
type EstimatedContributionLanguages struct {
	Languages          []EstimatedContributionLanguage `json:"languages"`
	CandidateRepoCount int                             `json:"candidate_repo_count"`
	SelectedRepoCount  int                             `json:"selected_repo_count"`
	SampledRepoCount   int                             `json:"sampled_repo_count"`
}

type SignatureWork struct {
	ImpactRepoRepresentatives []ImpactRepo           `json:"impact_repo_representatives"`
	WorkClusters              []SignatureWorkCluster `json:"work_clusters"`
	// OrganizationMaintainedRepos is a presentation-only side channel. Unlike
	// attributed originals in TopRepos it is not a scoring input.
	OrganizationMaintainedRepos []OrganizationMaintainedRepo `json:"organization_maintained_repos,omitempty"`
	// EstimatedContributionLanguages is profile-only language evidence built
	// from the unchanged public contribution aggregation.
	EstimatedContributionLanguages *EstimatedContributionLanguages `json:"estimated_contribution_languages,omitempty"`
	Source                         string                          `json:"source"`
}

var signatureWorkRE = regexp.MustCompile(`(?i)\b(fix|security|auth|credential|capabilit|boundary|bound|revoke|cleanup|retry|ledger|atomic|consistency|provenance|runtime|workflow|inference|metadata|lifecycle|parser|type inference|rustdoc|inlay|syntax)\b`)
var presentationOrDocTitleRE = regexp.MustCompile(`(?i)\b(docs?|documentation|readme|typo|translate|translation|i18n|website|site|blog|examples?|templates?|tutorial|guide|manual|css|tailwind|style|styles|ui|ux)\b|homepage|home\s*page|media\s*quer`)

func isSignatureQualityTitle(title string) bool {
	return signatureWorkRE.MatchString(title) && !presentationOrDocTitleRE.MatchString(title)
}

func signatureImpactRepos(repos []ImpactRepo) []ImpactRepo {
	chosen := []ImpactRepo{}
	for _, repo := range repos {
		if repo.PRs+repo.Commits >= 2 || repo.Stars >= 10000 {
			chosen = append(chosen, repo)
		}
	}
	sort.SliceStable(chosen, func(i, j int) bool {
		left, right := chosen[i].PRs*4+chosen[i].Commits, chosen[j].PRs*4+chosen[j].Commits
		return left > right || (left == right && chosen[i].Stars > chosen[j].Stars)
	})
	if len(chosen) > 12 {
		chosen = chosen[:12]
	}
	return chosen
}

func clusterScore(cluster SignatureWorkCluster) float64 {
	return cluster.QualityKeywordHits*3 + valueOrZero(cluster.RecentMergedPRsInSample)
}

func addClusterExample(cluster *SignatureWorkCluster, title string, important bool) {
	if important {
		examples := []string{title}
		for _, example := range cluster.Examples {
			if example != title {
				examples = append(examples, example)
			}
		}
		if len(examples) > 4 {
			examples = examples[:4]
		}
		cluster.Examples = examples
	} else if len(cluster.Examples) < 2 {
		for _, example := range cluster.Examples {
			if example == title {
				return
			}
		}
		cluster.Examples = append(cluster.Examples, title)
	}
}

func attachOrgContext(clusters []SignatureWorkCluster, impact []ImpactRepo) []SignatureWorkCluster {
	byOwner := map[string]ImpactRepo{}
	for _, repo := range impact {
		owner := repoOwner(repo.Repo)
		if owner == "" || repo.Stars < 10000 {
			continue
		}
		if current, ok := byOwner[owner]; !ok || repo.Stars > current.Stars {
			byOwner[owner] = repo
		}
	}
	for index := range clusters {
		context, ok := byOwner[repoOwner(clusters[index].Repo)]
		if !ok || strings.EqualFold(context.Repo, clusters[index].Repo) {
			continue
		}
		clusters[index].OrgContextRepo = stringPointer(context.Repo)
		clusters[index].OrgContextStars = floatPointer(context.Stars)
	}
	return clusters
}

func BuildRecentSignatureWork(impact []ImpactRepo, recent []RecentPR) SignatureWork {
	clustersByRepo := map[string]*SignatureWorkCluster{}
	order := []string{}
	for _, pr := range recent {
		if pr.Repo == nil || *pr.Repo == "" {
			continue
		}
		cluster := clustersByRepo[*pr.Repo]
		if cluster == nil {
			cluster = &SignatureWorkCluster{Repo: *pr.Repo, Stars: pr.RepoStars, RecentMergedPRsInSample: floatPointer(0), Examples: []string{}}
			clustersByRepo[*pr.Repo] = cluster
			order = append(order, *pr.Repo)
		}
		*cluster.RecentMergedPRsInSample++
		cluster.Stars = max(cluster.Stars, pr.RepoStars)
		if pr.Title != nil && strings.TrimSpace(*pr.Title) != "" {
			title := strings.TrimSpace(*pr.Title)
			if isSignatureQualityTitle(title) {
				cluster.QualityKeywordHits++
				addClusterExample(cluster, title, true)
			} else {
				addClusterExample(cluster, title, false)
			}
		}
	}
	clusters := []SignatureWorkCluster{}
	for _, key := range order {
		cluster := *clustersByRepo[key]
		if valueOrZero(cluster.RecentMergedPRsInSample) >= 3 || cluster.QualityKeywordHits >= 2 {
			clusters = append(clusters, cluster)
		}
	}
	sort.SliceStable(clusters, func(i, j int) bool {
		return clusterScore(clusters[i]) > clusterScore(clusters[j]) || (clusterScore(clusters[i]) == clusterScore(clusters[j]) && clusters[i].Stars > clusters[j].Stars)
	})
	if len(clusters) > 5 {
		clusters = clusters[:5]
	}
	return SignatureWork{ImpactRepoRepresentatives: signatureImpactRepos(impact), WorkClusters: attachOrgContext(clusters, impact), Source: "recent_sample"}
}
