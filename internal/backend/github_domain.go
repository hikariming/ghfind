package backend

import (
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The types in this file mirror the public JSON emitted by POST /api/scan.
// They are intentionally not database models: existing Turso JSON snapshots
// remain the persistence contract and require no migration.
type ReadmeFeatures struct {
	Length            float64 `json:"length"`
	HeadingCount      float64 `json:"heading_count"`
	HasInstall        bool    `json:"has_install"`
	HasUsage          bool    `json:"has_usage"`
	HasAPI            bool    `json:"has_api"`
	HasDemo           bool    `json:"has_demo"`
	HasFeatures       bool    `json:"has_features"`
	HasDeploy         bool    `json:"has_deploy"`
	HasTest           bool    `json:"has_test"`
	HasArchitecture   bool    `json:"has_architecture"`
	HasScreenshot     bool    `json:"has_screenshot"`
	PlaceholderScore  float64 `json:"placeholder_score"`
	ContentDepthScore float64 `json:"content_depth_score"`
	PromptSummary     string  `json:"prompt_summary"`
}

type RepoReadme struct {
	Path      string         `json:"path"`
	SHA       *string        `json:"sha"`
	Size      float64        `json:"size"`
	HTMLURL   *string        `json:"html_url"`
	Truncated bool           `json:"truncated"`
	Features  ReadmeFeatures `json:"features"`
}

type RepoLanguage struct {
	Name string  `json:"name"`
	Size float64 `json:"size"`
}

type TopRepo struct {
	Name                string         `json:"name"`
	OwnerLogin          *string        `json:"owner_login,omitempty"`
	NameWithOwner       *string        `json:"name_with_owner,omitempty"`
	Stars               float64        `json:"stars"`
	Forks               float64        `json:"forks"`
	OpenIssues          float64        `json:"open_issues"`
	OpenIssueCount      *float64       `json:"open_issue_count,omitempty"`
	Size                float64        `json:"size"`
	Language            *string        `json:"language"`
	Description         *string        `json:"description"`
	PushedAt            *string        `json:"pushed_at"`
	Readme              *RepoReadme    `json:"readme,omitempty"`
	ReadmeExcerpt       *string        `json:"readme_excerpt,omitempty"`
	Topics              []string       `json:"topics,omitempty"`
	Languages           []RepoLanguage `json:"languages,omitempty"`
	AttributedOriginal  bool           `json:"attributed_original,omitempty"`
	AttributionEvidence []string       `json:"attribution_evidence,omitempty"`
}

type RecentPR struct {
	Title        *string  `json:"title"`
	Repo         *string  `json:"repo"`
	RepoStars    float64  `json:"repo_stars"`
	Churn        float64  `json:"churn"`
	ChangedFiles float64  `json:"changed_files"`
	Trivial      bool     `json:"trivial"`
	Files        []string `json:"files,omitempty"`
}

type ImpactRepo struct {
	Repo    string  `json:"repo"`
	Stars   float64 `json:"stars"`
	Commits float64 `json:"commits"`
	PRs     float64 `json:"prs"`
}

type ScanResult struct {
	Metrics           RawMetrics    `json:"metrics"`
	TopRepos          []TopRepo     `json:"top_repos"`
	RecentPRs         []RecentPR    `json:"recent_prs"`
	FloodPRTitles     []string      `json:"flood_pr_titles"`
	ImpactRepos       []ImpactRepo  `json:"impact_repos,omitempty"`
	VerifiedImpactPRs []RecentPR    `json:"verified_impact_prs,omitempty"`
	SignatureWork     SignatureWork `json:"signature_work"`
	PinnedRepos       []string      `json:"pinned_repos,omitempty"`
	Organizations     []string      `json:"organizations,omitempty"`
	Scoring           Scoring       `json:"scoring"`
}

func repoDisplayName(repo TopRepo) string {
	if repo.NameWithOwner != nil && *repo.NameWithOwner != "" {
		return *repo.NameWithOwner
	}
	return repo.Name
}

func parseTimestamp(value *string) (time.Time, bool) {
	if value == nil || *value == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339, *value)
	return parsed, err == nil
}

var placeholderProjectRE = regexp.MustCompile(`\b(wip|todo|tmp|temp|scratch|playground|practice|learning|notes?|leetcode|algorithm|blog|profile)\b`)
var placeholderReadmeRE = regexp.MustCompile(`\b(wip|todo|scratch project|playground only|learning notes)\b`)

func meaningfulText(value *string) string {
	if value == nil {
		return ""
	}
	withoutTags := regexp.MustCompile(`<[^>]*>`).ReplaceAllString(*value, " ")
	return strings.TrimSpace(strings.Join(strings.Fields(withoutTags), " "))
}

func likelyPlaceholderProject(repo TopRepo, loginLower string) bool {
	name := strings.ToLower(repo.Name)
	if !repo.AttributedOriginal && name == loginLower {
		return true
	}
	nameAndDescription := name + " " + strings.ToLower(valueOrString(repo.Description, ""))
	if placeholderProjectRE.MatchString(nameAndDescription) {
		return true
	}
	readme := strings.ToLower(valueOrString(repo.ReadmeExcerpt, ""))
	return (repo.Readme != nil && repo.Readme.Features.PlaceholderScore >= 0.6) || placeholderReadmeRE.MatchString(readme)
}

// OriginalRepoQualityScore is the existing 0..1 project-substance signal.
// Stars are intentionally not included; Score() applies them separately.
func OriginalRepoQualityScore(repo TopRepo, loginLower string, now time.Time) float64 {
	if repo.Size <= 0 {
		return 0
	}
	readmeLength := float64(len(meaningfulText(repo.ReadmeExcerpt)))
	if repo.Readme != nil {
		readmeLength = repo.Readme.Features.Length
	}
	descriptionLength := float64(len(meaningfulText(repo.Description)))
	ageDays := -1.0
	if pushed, ok := parseTimestamp(repo.PushedAt); ok {
		ageDays = math.Floor(now.Sub(pushed).Hours() / 24)
	}
	score := 0.0
	switch {
	case repo.Size >= 1000:
		score += 0.25
	case repo.Size >= 200:
		score += 0.2
	case repo.Size >= 50:
		score += 0.15
	case repo.Size >= 10:
		score += 0.08
	}
	if repo.Language != nil && *repo.Language != "" {
		score += 0.15
	}
	if descriptionLength >= 20 {
		score += 0.15
	}
	switch {
	case readmeLength >= 800:
		score += 0.25
	case readmeLength >= 300:
		score += 0.2
	case readmeLength >= 120:
		score += 0.12
	}
	hasSignal := false
	if repo.Readme != nil {
		features := repo.Readme.Features
		hasSignal = features.HasInstall || features.HasUsage || features.HasAPI || features.HasDemo || features.HasFeatures || features.HasDeploy || features.HasTest || features.HasArchitecture || features.HasScreenshot
	} else {
		hasSignal = regexp.MustCompile(`(?i)\b(install|usage|quickstart|quick start|api|demo|features?|deploy|architecture|test|screenshot)\b`).MatchString(valueOrString(repo.ReadmeExcerpt, ""))
	}
	if hasSignal {
		score += 0.1
	}
	switch {
	case ageDays >= 0 && ageDays <= 180:
		score += 0.1
	case ageDays >= 0 && ageDays <= 365:
		score += 0.07
	case ageDays >= 0 && ageDays <= 730:
		score += 0.04
	}
	if likelyPlaceholderProject(repo, loginLower) {
		if readmeLength >= 600 && repo.Size >= 200 {
			score *= 0.55
		} else {
			score *= 0.25
		}
	}
	return roundJS(max(0, min(score, 1))*100) / 100
}

func BestOriginalRepoQuality(repos []TopRepo, loginLower string, now time.Time) (float64, *string) {
	best := 0.0
	var bestRepo *string
	for _, repo := range repos {
		quality := OriginalRepoQualityScore(repo, loginLower, now)
		if quality > best {
			best = quality
			name := repoDisplayName(repo)
			bestRepo = &name
		}
	}
	return best, bestRepo
}

func TopStarredOriginalRepoQuality(repos []TopRepo, loginLower string, now time.Time) (float64, *string) {
	var top *TopRepo
	for index := range repos {
		if repos[index].Stars > 0 && (top == nil || repos[index].Stars > top.Stars) {
			top = &repos[index]
		}
	}
	if top == nil {
		return 0, nil
	}
	name := repoDisplayName(*top)
	return OriginalRepoQualityScore(*top, loginLower, now), &name
}

type AnyPR struct {
	Title string
	Repo  string
}

type FloodSignals struct {
	RecentPRSample   float64  `json:"recent_pr_sample"`
	TopRepoPRTarget  *string  `json:"top_repo_pr_target"`
	TopRepoPRShare   float64  `json:"top_repo_pr_share"`
	TemplatedPRRatio float64  `json:"templated_pr_ratio"`
	PRFloodSuspect   bool     `json:"pr_flood_suspect"`
	FloodPRTitles    []string `json:"flood_pr_titles"`
}

func repoOwner(name string) string {
	owner, _, found := strings.Cut(name, "/")
	if !found {
		return ""
	}
	return strings.ToLower(owner)
}

func ComputeFloodSignals(prs []AnyPR, loginLower string) FloodSignals {
	if len(prs) == 0 {
		return FloodSignals{FloodPRTitles: []string{}}
	}
	repoCounts := map[string]int{}
	for _, pr := range prs {
		repoCounts[pr.Repo]++
	}
	var topRepo string
	topCount := 0
	for _, pr := range prs { // preserve JS Map insertion-order tie resolution.
		if repoCounts[pr.Repo] > topCount {
			topRepo, topCount = pr.Repo, repoCounts[pr.Repo]
		}
	}
	topRepoShare := roundJS(float64(topCount)/float64(len(prs))*100) / 100
	clusters := map[string][]string{}
	clusterOrder := []string{}
	for _, pr := range prs {
		key := titlePrefix(pr.Title)
		if _, exists := clusters[key]; !exists {
			clusterOrder = append(clusterOrder, key)
		}
		clusters[key] = append(clusters[key], pr.Title)
	}
	biggest := []string{}
	for _, key := range clusterOrder {
		if len(clusters[key]) > len(biggest) {
			biggest = clusters[key]
		}
	}
	templatedRatio := roundJS(float64(len(biggest))/float64(len(prs))*100) / 100
	topIsExternal := repoOwner(topRepo) != "" && repoOwner(topRepo) != strings.ToLower(loginLower)
	return FloodSignals{
		RecentPRSample:   float64(len(prs)),
		TopRepoPRTarget:  stringPointer(topRepo),
		TopRepoPRShare:   topRepoShare,
		TemplatedPRRatio: templatedRatio,
		PRFloodSuspect:   len(prs) >= 10 && topIsExternal && topRepoShare >= 0.5 && templatedRatio >= 0.5,
		FloodPRTitles:    append(make([]string, 0, minInt(len(biggest), 5)), biggest[:minInt(len(biggest), 5)]...),
	}
}

func titlePrefix(title string) string {
	normalized := strings.ToLower(strings.Join(strings.Fields(title), " "))
	runes := []rune(normalized)
	if len(runes) > 18 {
		runes = runes[:18]
	}
	return string(runes)
}

func IsEcosystemImpactPR(pr RecentPR, loginLower string) bool {
	if pr.Repo == nil || pr.Trivial {
		return false
	}
	owner := repoOwner(*pr.Repo)
	if owner == "" {
		return false
	}
	threshold := 200.0
	if owner == strings.ToLower(loginLower) {
		threshold = 1000
	}
	return pr.RepoStars >= threshold
}

func IsExternalTrivialFarmPR(pr RecentPR, loginLower string) bool {
	if pr.Repo == nil {
		return false
	}
	owner := repoOwner(*pr.Repo)
	return owner != "" && owner != strings.ToLower(loginLower) && pr.Trivial && pr.RepoStars >= 200
}

var docLikePathRE = regexp.MustCompile(`(?i)\.(md|mdx|rst|adoc|txt)$|(^|/)(docs?|site|website|blog|content|articles|examples?|templates?|tutorials?|guides?|manual|i18n|locales?)(/|$)|(^|/)(readme|changelog|contributing|license)(\.[^/]*)?$`)
var presentationPathRE = regexp.MustCompile(`(?i)\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp)$|(^|/)(__snapshots__|demo|demos|examples?|templates?|storybook|screenshots?|assets?|public)(/|$)|(^|/)(site|website|docs?|pages/home|components/homepage)(/|$)`)
var coreCodePathRE = regexp.MustCompile(`(?i)\.(c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|swift|ts|tsx)$`)
var docLikeTitleRE = regexp.MustCompile(`(?i)\b(docs?|readme|typo|translate|translation|i18n|website|site|blog|examples?|templates?|tutorial|guide)\b`)
var docLikeRepoRE = regexp.MustCompile(`(^|[-_.])(docs?|site|website|blog|examples?|templates?|profile|notebook|learning|tutorial|interview|guide|manual)([-_.]|$)`)

func isLowSignalEntryRepo(repo string) bool {
	return strings.EqualFold(strings.TrimSpace(repo), "is-a-dev/register") || strings.EqualFold(strings.TrimSpace(repo), "tuna/blogroll")
}

func isDocLikeRepo(repo string) bool {
	if isLowSignalEntryRepo(repo) {
		return true
	}
	_, name, found := strings.Cut(strings.ToLower(repo), "/")
	if !found {
		name = strings.ToLower(repo)
	}
	return docLikeRepoRE.MatchString(name) || strings.HasSuffix(name, ".github.io")
}

func isDocLikePath(path string) bool { return docLikePathRE.MatchString(strings.ToLower(path)) }
func isPresentationOnlyPath(path string) bool {
	return presentationPathRE.MatchString(strings.ToLower(path))
}
func isCoreCodePath(path string) bool {
	return !isDocLikePath(path) && !isPresentationOnlyPath(path) && coreCodePathRE.MatchString(strings.ToLower(path))
}

func IsDocLikeImpactPR(pr RecentPR) bool {
	if pr.Repo != nil && isDocLikeRepo(*pr.Repo) {
		return true
	}
	if pr.Title != nil && docLikeTitleRE.MatchString(*pr.Title) {
		return true
	}
	if len(pr.Files) == 0 {
		return false
	}
	docLike, coreCode := 0, 0
	for _, file := range pr.Files {
		if isDocLikePath(file) || isPresentationOnlyPath(file) {
			docLike++
		}
		if isCoreCodePath(file) {
			coreCode++
		}
	}
	return docLike > 0 && (coreCode == 0 || float64(docLike)/float64(len(pr.Files)) >= 0.6)
}

type ImpactQualitySignals struct {
	VerifiedImpactPRCount   float64  `json:"verified_impact_pr_count"`
	CoreImpactPRCount       float64  `json:"core_impact_pr_count"`
	DocLikeImpactPRCount    float64  `json:"doc_like_impact_pr_count"`
	UnverifiedImpactPRCount float64  `json:"unverified_impact_pr_count"`
	ImpactQualityCap        *float64 `json:"impact_quality_cap,omitempty"`
}

func lowQualityImpactCap(verified, docLike, core, impactPRCount float64) *float64 {
	if verified <= 0 || docLike <= core {
		return nil
	}
	dominance := (docLike - core) / verified
	confidence := math.Sqrt(LogRatio(verified, 10) * LogRatio(max(impactPRCount, verified), 10))
	cap := roundJS(max(4, min(20, 20-max(0, min(1, dominance*confidence))*36))*10) / 10
	return &cap
}

func ComputeImpactQualitySignals(recentPRs []RecentPR, impactPRCount float64, loginLower string, workflowLandedImpactPRCount float64) ImpactQualitySignals {
	verified, docLike := 0.0, 0.0
	for _, pr := range recentPRs {
		if IsEcosystemImpactPR(pr, loginLower) {
			verified++
			if IsDocLikeImpactPR(pr) {
				docLike++
			}
		}
	}
	core := verified - docLike
	return ImpactQualitySignals{
		VerifiedImpactPRCount:   verified,
		CoreImpactPRCount:       core,
		DocLikeImpactPRCount:    docLike,
		UnverifiedImpactPRCount: max(0, impactPRCount-verified-workflowLandedImpactPRCount),
		ImpactQualityCap:        lowQualityImpactCap(verified, docLike, core, impactPRCount),
	}
}

type ContribRepoAgg struct {
	Repo        string  `json:"repo"`
	Stars       float64 `json:"stars"`
	IsPrivate   bool    `json:"is_private"`
	IsFork      bool    `json:"is_fork"`
	OwnerLogin  string  `json:"owner_login"`
	Commits     float64 `json:"commits"`
	PRs         float64 `json:"prs"`
	ActiveYears float64 `json:"active_years"`
}

type ImpactMetrics struct {
	MaxImpactRepoStars  float64      `json:"max_impact_repo_stars"`
	ImpactPrestigeScore float64      `json:"impact_prestige_score"`
	ImpactDepthRaw      float64      `json:"impact_depth_raw"`
	ImpactRepoCount     float64      `json:"impact_repo_count"`
	ImpactCommitCount   float64      `json:"impact_commit_count"`
	ImpactPRCount       float64      `json:"impact_pr_count"`
	ImpactRepos         []ImpactRepo `json:"impact_repos"`
}

func defaultBranchCommitMin(repo string) float64 {
	if strings.EqualFold(strings.TrimSpace(repo), "git/git") {
		return 1
	}
	return 2
}

func prestigeWorkMultiplier(commits, prs float64) float64 {
	workSignal := max(max(0, commits)/10, max(0, prs)/3)
	if workSignal <= 0 {
		return 0
	}
	if workSignal >= 1 {
		return 1
	}
	return math.Log10(1+workSignal*9) / math.Log10(10)
}

func ComputeImpactFromContribMap(repos []ContribRepoAgg, loginLower string) ImpactMetrics {
	qualifying := make([]ContribRepoAgg, 0)
	for _, repo := range repos {
		if repo.IsPrivate || repo.IsFork || (isLowSignalEntryRepo(repo.Repo) && repo.Commits <= 1 && repo.PRs <= 1) {
			continue
		}
		threshold := 200.0
		if strings.EqualFold(repo.OwnerLogin, loginLower) {
			threshold = 1000
		}
		if repo.Stars >= threshold && (repo.Commits >= defaultBranchCommitMin(repo.Repo) || repo.PRs >= 1) {
			qualifying = append(qualifying, repo)
		}
	}
	metrics := ImpactMetrics{ImpactRepos: []ImpactRepo{}}
	prestige, depth := 0.0, 0.0
	for _, repo := range qualifying {
		metrics.MaxImpactRepoStars = max(metrics.MaxImpactRepoStars, repo.Stars)
		metrics.ImpactCommitCount += repo.Commits
		metrics.ImpactPRCount += repo.PRs
		prestige = max(prestige, LogRatio(repo.Stars, 100000)*prestigeWorkMultiplier(repo.Commits, repo.PRs))
		depth += LogRatio(repo.Stars, 5000) * min(1+math.Log10(repo.Commits+repo.PRs), 2.5)
	}
	metrics.ImpactRepoCount = float64(len(qualifying))
	metrics.ImpactPrestigeScore = roundJS(prestige*10000) / 10000
	metrics.ImpactDepthRaw = roundJS(depth*100) / 100
	byStars := append([]ContribRepoAgg(nil), qualifying...)
	sort.SliceStable(byStars, func(i, j int) bool { return byStars[i].Stars > byStars[j].Stars })
	if len(byStars) > 6 {
		byStars = byStars[:6]
	}
	byWork := append([]ContribRepoAgg(nil), qualifying...)
	sort.SliceStable(byWork, func(i, j int) bool {
		iWork, jWork := byWork[i].PRs*4+byWork[i].Commits, byWork[j].PRs*4+byWork[j].Commits
		return iWork > jWork || (iWork == jWork && byWork[i].Stars > byWork[j].Stars)
	})
	if len(byWork) > 8 {
		byWork = byWork[:8]
	}
	seen := map[string]bool{}
	for _, repo := range append(byStars, byWork...) {
		if seen[repo.Repo] || len(metrics.ImpactRepos) == 12 {
			continue
		}
		seen[repo.Repo] = true
		metrics.ImpactRepos = append(metrics.ImpactRepos, ImpactRepo{Repo: repo.Repo, Stars: repo.Stars, Commits: repo.Commits, PRs: repo.PRs})
	}
	return metrics
}

func MergeContribRepoAggs(groups ...[]ContribRepoAgg) []ContribRepoAgg {
	merged := map[string]ContribRepoAgg{}
	order := []string{}
	for _, group := range groups {
		for _, repo := range group {
			current, exists := merged[repo.Repo]
			if !exists {
				current = repo
				current.Stars, current.Commits, current.PRs, current.ActiveYears = 0, 0, 0, 0
				order = append(order, repo.Repo)
			}
			current.Stars = max(current.Stars, repo.Stars)
			current.IsPrivate = current.IsPrivate || repo.IsPrivate
			current.IsFork = current.IsFork || repo.IsFork
			current.Commits += repo.Commits
			current.PRs += repo.PRs
			current.ActiveYears = max(current.ActiveYears, repo.ActiveYears)
			merged[repo.Repo] = current
		}
	}
	result := make([]ContribRepoAgg, 0, len(order))
	for _, key := range order {
		result = append(result, merged[key])
	}
	return result
}

type OrgRepoAttribution struct {
	Repo     string
	Evidence []string
	Score    float64
}

func hasStrongLongTermOrgContribution(repo ContribRepoAgg) bool {
	if repo.ActiveYears >= 2 {
		return repo.Commits >= 50 || (repo.Commits >= 20 && repo.PRs >= 10)
	}
	return repo.Commits >= 100
}

// ComputeOrgRepoAttribution is deliberately narrow: only a public,
// non-documentation repository owned by a public organization the developer
// belongs to may be credited as their original work, and it needs long-term
// contribution evidence. Pinned/release/maintainer proofs strengthen it.
func ComputeOrgRepoAttribution(repo ContribRepoAgg, organizations, pinnedRepos []string, releaseOrTagAuthorHit, maintainerFileHit bool) *OrgRepoAttribution {
	member := false
	for _, organization := range organizations {
		if strings.EqualFold(organization, repo.OwnerLogin) {
			member = true
			break
		}
	}
	if !member || repo.IsPrivate || repo.IsFork || isDocLikeRepo(repo.Repo) || !hasStrongLongTermOrgContribution(repo) {
		return nil
	}
	evidence := []string{"org member of " + repo.OwnerLogin, formatNumber(repo.Commits) + " commits + " + formatNumber(repo.PRs) + " PRs across " + formatNumber(repo.ActiveYears) + " years"}
	score := 5.0
	for _, pinned := range pinnedRepos {
		if strings.EqualFold(pinned, repo.Repo) {
			score++
			evidence = append(evidence, "pinned by user")
			break
		}
	}
	if releaseOrTagAuthorHit {
		score += 3
		evidence = append(evidence, "release/tag author")
	}
	if maintainerFileHit {
		score += 3
		evidence = append(evidence, "listed in maintainer/codeowner docs")
	}
	if score < 5 {
		return nil
	}
	return &OrgRepoAttribution{Repo: repo.Repo, Evidence: evidence, Score: score}
}

type ClosedPRNode struct {
	ID              string
	AuthorLogin     *string
	RepositoryOwner *string
	ClosedBy        *string
}

type ClosedPRBreakdown struct {
	ClosedUnmergedPRCount           float64 `json:"closed_unmerged_pr_count"`
	MaintainerClosedUnmergedPRCount float64 `json:"maintainer_closed_unmerged_pr_count"`
	SelfClosedExternalPRCount       float64 `json:"self_closed_external_pr_count"`
	SelfClosedOwnRepoPRCount        float64 `json:"self_closed_own_repo_pr_count"`
	UnknownClosedUnmergedPRCount    float64 `json:"unknown_closed_unmerged_pr_count"`
}

func ComputeClosedPRBreakdown(nodes []ClosedPRNode, total float64, loginLower string, workflowLandedIDs map[string]bool) ClosedPRBreakdown {
	result := ClosedPRBreakdown{UnknownClosedUnmergedPRCount: max(0, total-float64(len(nodes)))}
	for _, node := range nodes {
		if node.ID != "" && workflowLandedIDs[node.ID] {
			continue
		}
		author := strings.ToLower(valueOrString(node.AuthorLogin, loginLower))
		owner := strings.ToLower(valueOrString(node.RepositoryOwner, ""))
		actor := strings.ToLower(valueOrString(node.ClosedBy, ""))
		switch {
		case actor == "":
			result.UnknownClosedUnmergedPRCount++
		case actor == author || actor == strings.ToLower(loginLower):
			if owner == strings.ToLower(loginLower) {
				result.SelfClosedOwnRepoPRCount++
			} else {
				result.SelfClosedExternalPRCount++
			}
		case owner == strings.ToLower(loginLower):
			result.UnknownClosedUnmergedPRCount++
		default:
			result.MaintainerClosedUnmergedPRCount++
		}
	}
	result.ClosedUnmergedPRCount = max(0, total-float64(len(workflowLandedIDs)))
	return result
}

func valueOrString(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func stringPointer(value string) *string { return &value }
func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
