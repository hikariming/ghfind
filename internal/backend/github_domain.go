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

// A "notes"/"learning" keyword is weak evidence once a substantive repo has
// real organic traction (many stars backed by a healthy fork share); mirrors
// hasOrganicProjectTraction in src/lib/github.ts.
const (
	placeholderTractionMinStars     = 500
	placeholderTractionMinForkRatio = 0.03
	placeholderTractionMultiplier   = 0.75
)

func hasOrganicProjectTraction(repo TopRepo) bool {
	return repo.Stars >= placeholderTractionMinStars && repo.Forks >= repo.Stars*placeholderTractionMinForkRatio
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
			if hasOrganicProjectTraction(repo) {
				score *= placeholderTractionMultiplier
			} else {
				score *= 0.55
			}
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

// IsEcosystemImpactPR mirrors isEcosystemImpactPr in src/lib/github.ts: a
// substantial PR into someone else's repo with >=200 stars. Own repos are
// credited through the contribution aggregates, never as ecosystem PRs.
func IsEcosystemImpactPR(pr RecentPR, loginLower string, repoSets ...[]ContribRepoAgg) bool {
	if pr.Repo == nil || pr.Trivial {
		return false
	}
	owner := repoOwner(*pr.Repo)
	if owner == "" || owner == strings.ToLower(loginLower) {
		return false
	}
	for _, repos := range repoSets {
		for _, repo := range repos {
			if strings.EqualFold(repo.Repo, *pr.Repo) && isOwnImpactRepo(repo, loginLower) {
				return hasAttributedCreatorStarCredit(repo, loginLower) && passesImpactRepoGates(repo, loginLower) && (repo.Stars >= docResourceImpactMinStars || !isDocOrResourceRepo(repo))
			}
		}
	}
	return pr.RepoStars >= 200
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

// Project websites: "<x>-site", "<x>-website", "<x>-homepage", or a name that
// simply ends in "website". A bare trailing "site" needs a separator so code
// such as "composite" or "parasite" is not swept up. Domain-style names only
// count for GitHub Pages: "socket.io" or "foo.org" are real projects.
var siteRepoNameRE = regexp.MustCompile(`(^|[-_.])(site|homepage)$|website$`)
var resourceRepoTopicRE = regexp.MustCompile(`(?i)^(awesome|awesome-lists?|courses?|tutorials?|notes|docs|documentation)$`)

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
	return docLikeRepoRE.MatchString(name) || siteRepoNameRE.MatchString(name) || strings.HasSuffix(name, ".github.io")
}

// isDocOrResourceRepo matches docs/site repos by name, plus resource
// collections (awesome lists, courses, tutorials, notes) by GitHub topic.
func isDocOrResourceRepo(repo ContribRepoAgg) bool {
	if isDocLikeRepo(repo.Repo) {
		return true
	}
	for _, topic := range repo.Topics {
		if resourceRepoTopicRE.MatchString(topic) {
			return true
		}
	}
	return false
}

// UI libraries, design systems and component kits ship their styles: there a
// stylesheet is product code, not presentation (e.g. ant-design/x).
var styleFileRE = regexp.MustCompile(`(?i)\.(css|scss|sass|less|styl)$`)
var uiLibraryRepoRE = regexp.MustCompile(`(?i)(^|[-_./])(ui|design|design-system|components?|widgets?|styles?|css|themes?|antd|mui|chakra|shadcn|tailwind(css)?)([-_./]|$)`)

func isUiLibraryRepo(repo string) bool { return uiLibraryRepoRE.MatchString(repo) }

func isDocLikePath(path string) bool { return docLikePathRE.MatchString(strings.ToLower(path)) }
func isPresentationOnlyPath(path string, uiLibrary bool) bool {
	lower := strings.ToLower(path)
	if uiLibrary && styleFileRE.MatchString(lower) {
		return false
	}
	return presentationPathRE.MatchString(lower)
}
func isCoreCodePath(path string, uiLibrary bool) bool {
	if isDocLikePath(path) || isPresentationOnlyPath(path, uiLibrary) {
		return false
	}
	lower := strings.ToLower(path)
	return (uiLibrary && styleFileRE.MatchString(lower)) || coreCodePathRE.MatchString(lower)
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
	uiLibrary := pr.Repo != nil && isUiLibraryRepo(*pr.Repo)
	docLike, coreCode := 0, 0
	for _, file := range pr.Files {
		if isDocLikePath(file) || isPresentationOnlyPath(file, uiLibrary) {
			docLike++
		}
		if isCoreCodePath(file, uiLibrary) {
			coreCode++
		}
	}
	return docLike > 0 && (coreCode == 0 || float64(docLike)/float64(len(pr.Files)) >= 0.6)
}

type ImpactQualitySignals struct {
	VerifiedImpactPRCount   float64 `json:"verified_impact_pr_count"`
	CoreImpactPRCount       float64 `json:"core_impact_pr_count"`
	DocLikeImpactPRCount    float64 `json:"doc_like_impact_pr_count"`
	UnverifiedImpactPRCount float64 `json:"unverified_impact_pr_count"`
}

// ComputeImpactQualitySignals mirrors computeImpactQualitySignals: verified
// external ecosystem PRs split into core and doc-like. Doc-heavy work is
// weighted per repo by code share in ComputeImpactFromContribMap.
func ComputeImpactQualitySignals(recentPRs []RecentPR, impactPRCount float64, loginLower string, workflowLandedImpactPRCount float64, repoSets ...[]ContribRepoAgg) ImpactQualitySignals {
	verified, docLike := 0.0, 0.0
	for _, pr := range recentPRs {
		if IsEcosystemImpactPR(pr, loginLower, repoSets...) {
			verified++
			if IsDocLikeImpactPR(pr) {
				docLike++
			}
		}
	}
	return ImpactQualitySignals{
		VerifiedImpactPRCount:   verified,
		CoreImpactPRCount:       verified - docLike,
		DocLikeImpactPRCount:    docLike,
		UnverifiedImpactPRCount: max(0, impactPRCount-verified-workflowLandedImpactPRCount),
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
	// MergeCommits estimates how many of Commits are merge commits (more than
	// one parent); Topics feeds resource-repo detection. Both are absent when
	// the repo signal query was unavailable.
	MergeCommits float64  `json:"merge_commits,omitempty"`
	Topics       []string `json:"topics,omitempty"`
	// Months lists distinct "YYYY-MM" months with a merged PR or an authored
	// commit here; empty means unknown (no tenure discount).
	Months []string `json:"months,omitempty"`
	// PRSample merged PRs here were file-classified (<=10), CodePRSample of
	// them changed code rather than docs/site/examples. Zero = no sample.
	PRSample     float64 `json:"pr_sample,omitempty"`
	CodePRSample float64 `json:"code_pr_sample,omitempty"`
	// Engagement is the repo's (watchers + issues + PRs) / stars; nil = not
	// measured.
	Engagement *float64 `json:"engagement,omitempty"`
	// AttributedOriginal marks an org repo credited as the user's original
	// project: it counts as own.
	AttributedOriginal   bool     `json:"attributed_original,omitempty"`
	AttributionEvidence  []string `json:"attribution_evidence,omitempty"`
	Forks                float64  `json:"forks,omitempty"`
	StarInflationSuspect bool     `json:"star_inflation_suspect,omitempty"`
	// CommunityFacts/Community: own-project community (absent = not measured);
	// Community is 0 for star-inflation suspects.
	CommunityFacts *OwnRepoCommunityFacts `json:"community_facts,omitempty"`
	Community      *float64               `json:"community,omitempty"`
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

// Work levels at which a repo gets full prestige credit: prestige needs
// sustained work, not a handful of PRs.
const (
	prestigeCommitFullAt   = 40
	prestigeMergedPRFullAt = 12
)

func prestigeWorkMultiplier(commits, prs float64) float64 {
	workSignal := max(max(0, commits)/prestigeCommitFullAt, max(0, prs)/prestigeMergedPRFullAt)
	if workSignal <= 0 {
		return 0
	}
	if workSignal >= 1 {
		return 1
	}
	return math.Log10(1+workSignal*9) / math.Log10(10)
}

// passesImpactRepoGates holds the popularity and landed-work gates shared by
// impact scoring and the repo signal query.
func passesImpactRepoGates(repo ContribRepoAgg, loginLower string) bool {
	if repo.IsPrivate || repo.IsFork || (isLowSignalEntryRepo(repo.Repo) && repo.Commits <= 1 && repo.PRs <= 1) {
		return false
	}
	// Own repos need 1000★ unless a measured outside community vouches for them.
	threshold := 200.0
	if isOwnImpactRepo(repo, loginLower) && !(valueOrZero(repo.Community) > 0) && !hasAttributedCreatorStarCredit(repo, loginLower) {
		threshold = ownRepoImpactMinStars
	}
	return repo.Stars >= threshold && (repo.Commits >= defaultBranchCommitMin(repo.Repo) || repo.PRs >= 1)
}

// isOwnImpactRepo covers the user's own repos and org repos credited as
// their original projects.
func hasAttributedCreatorStarCredit(repo ContribRepoAgg, loginLower string) bool {
	if !repo.AttributedOriginal || repo.StarInflationSuspect {
		return false
	}
	author := false
	for _, e := range repo.AttributionEvidence {
		if e == "release/tag author" || strings.EqualFold(e, "first commit author is "+loginLower) {
			author = true
		}
	}
	forks, outside := repo.Forks, 0.0
	if repo.CommunityFacts != nil {
		forks = max(forks, repo.CommunityFacts.Forks)
		outside = repo.CommunityFacts.OutsideMergedPRs
	}
	return author && (outside >= 1 || forks >= 10)
}

func isOwnImpactRepo(repo ContribRepoAgg, loginLower string) bool {
	return repo.AttributedOriginal || strings.EqualFold(repo.OwnerLogin, loginLower)
}

// Code-share and tenure weights. Runtime vars, not constants, so 1-floor is
// evaluated in float64 exactly like the TypeScript collector.
var (
	impactCodeSharePrior     = 0.7
	impactCodeShareFloor     = 0.3
	impactTenureFloor        = 0.7
	impactTenureFullMonths   = 6.0
	ownRepoImpactDepthWeight = 0.3
)

// impactRepoCodeWeight mirrors impactRepoCodeWeight in src/lib/github.ts: the
// observed code share is blended with the prior by how much of the repo's work
// (max of PRs and authored commits, capped at the sample size) it covers.
func impactRepoCodeWeight(repo ContribRepoAgg) float64 {
	share := impactCodeSharePrior
	if repo.PRSample > 0 {
		observed := max(0, min(repo.CodePRSample/repo.PRSample, 1))
		work := max(repo.PRs, authoredCommits(repo), 1)
		coverage := min(1, repo.PRSample/min(impactCodeSampleSize, work))
		share = coverage*observed + (1-coverage)*impactCodeSharePrior
	}
	return impactCodeShareFloor + (1-impactCodeShareFloor)*share
}

// impactRepoTenureWeight mirrors impactRepoTenureWeight in src/lib/github.ts.
func impactRepoTenureWeight(repo ContribRepoAgg) float64 {
	months := float64(len(repo.Months))
	if months == 0 {
		return 1
	}
	return impactTenureFloor + (1-impactTenureFloor)*min(months/impactTenureFullMonths, 1)
}

const (
	// Doc/resource repos below this many stars earn no ecosystem impact;
	// popular ones count at docResourceImpactWeight.
	docResourceImpactMinStars = 5000
	docResourceImpactWeight   = 0.5
)

// authoredCommits excludes merge commits from a repo's work count.
func authoredCommits(repo ContribRepoAgg) float64 {
	return max(0, repo.Commits-max(0, repo.MergeCommits))
}

// ComputeImpactFromContribMap mirrors computeImpactFromContribMap in
// src/lib/github.ts. Each repo is weighted by doc/resource kind, code share and
// tenure. Own repos (including attributed originals) earn impact from their
// outside community by default; proven attributed creators with outside adoption
// retain the historical external star formula unless inflation is suspected.
// Otherwise they earn community-based prestige, plus
// 2.5 x community depth on top of the legacy damped star depth (>=1000★).
//
// TODO(content-repos): also treat a repo as content when its file tree is
// >=70% md/pdf/png/mp3/html with fewer than 15 code files. The collector has
// no file listing for contribution repos, and a recursive tree per impact repo
// is too expensive to add to every scan.
func ComputeImpactFromContribMap(repos []ContribRepoAgg, loginLower string) ImpactMetrics {
	qualifying := make([]ContribRepoAgg, 0)
	for _, repo := range repos {
		if passesImpactRepoGates(repo, loginLower) && (repo.Stars >= docResourceImpactMinStars || !isDocOrResourceRepo(repo)) {
			qualifying = append(qualifying, repo)
		}
	}
	metrics := ImpactMetrics{ImpactRepos: []ImpactRepo{}}
	prestige, depth := 0.0, 0.0
	for _, repo := range qualifying {
		metrics.MaxImpactRepoStars = max(metrics.MaxImpactRepoStars, repo.Stars)
		metrics.ImpactCommitCount += repo.Commits
		metrics.ImpactPRCount += repo.PRs
		docWeight := 1.0
		if isDocOrResourceRepo(repo) {
			docWeight = docResourceImpactWeight
		}
		repoWeight := docWeight * impactRepoCodeWeight(repo) * impactRepoTenureWeight(repo)
		own := isOwnImpactRepo(repo, loginLower)
		// Own repos earn prestige from their outside community, never stars.
		prestigeBase := LogRatio(repo.Stars, 100000)
		if own {
			prestigeBase = valueOrZero(repo.Community)
		}
		prestige = max(prestige, prestigeBase*prestigeWorkMultiplier(authoredCommits(repo), repo.PRs)*repoWeight)
		if hasAttributedCreatorStarCredit(repo, loginLower) {
			prestige = max(prestige, LogRatio(repo.Stars, 100000)*prestigeWorkMultiplier(authoredCommits(repo), repo.PRs)*docWeight)
		}
		work := authoredCommits(repo) + repo.PRs
		weight := 0.0
		if work > 0 {
			weight = min(1+math.Log10(work), 2.5)
		}
		if own {
			// Legacy damped star depth (>=1000★ only) plus community depth.
			starDepth := 0.0
			if repo.Stars >= ownRepoImpactMinStars {
				starDepth = LogRatio(repo.Stars, 5000) * weight * repoWeight * (ownRepoImpactDepthWeight * starEngagementMultiplier(repo.Engagement))
			}
			ownDepth := starDepth + communityDepth*valueOrZero(repo.Community)*repoWeight
			if hasAttributedCreatorStarCredit(repo, loginLower) {
				ownDepth = max(ownDepth, LogRatio(repo.Stars, 5000)*weight*docWeight)
			}
			depth += ownDepth
		} else {
			depth += LogRatio(repo.Stars, 5000) * weight * repoWeight
		}
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
			if len(repo.Months) > 0 {
				current.Months = unionMonths(current.Months, repo.Months)
			}
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
func ComputeOrgRepoAttribution(repo ContribRepoAgg, organizations, pinnedRepos []string, releaseOrTagAuthorHit, maintainerFileHit bool, creatorLogins ...string) *OrgRepoAttribution {
	member := false
	for _, organization := range organizations {
		if strings.EqualFold(organization, repo.OwnerLogin) {
			member = true
			break
		}
	}
	firstCommitMatch := len(creatorLogins) == 2 && strings.TrimSpace(creatorLogins[0]) != "" && strings.EqualFold(strings.TrimSpace(creatorLogins[0]), strings.TrimSpace(creatorLogins[1]))
	if (!member && !firstCommitMatch) || repo.IsPrivate || repo.IsFork || isDocLikeRepo(repo.Repo) || !hasStrongLongTermOrgContribution(repo) {
		return nil
	}
	identity := "org member of " + repo.OwnerLogin
	if !member {
		identity = "first commit author is " + creatorLogins[1]
	}
	evidence := []string{identity, formatNumber(repo.Commits) + " commits + " + formatNumber(repo.PRs) + " PRs across " + formatNumber(repo.ActiveYears) + " years"}
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

// unionMonths returns the sorted distinct union of two month lists.
func unionMonths(left, right []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, month := range append(append([]string{}, left...), right...) {
		if !seen[month] {
			seen[month] = true
			result = append(result, month)
		}
	}
	sort.Strings(result)
	return result
}

// isProfileReadmeRepo mirrors isProfileReadmeRepo: the <login>/<login>
// profile page is not a project.
func isProfileReadmeRepo(repo TopRepo, loginLower string) bool {
	owner := loginLower
	if repo.OwnerLogin != nil {
		owner = strings.ToLower(*repo.OwnerLogin)
	}
	return !repo.AttributedOriginal && strings.ToLower(repo.Name) == loginLower && owner == loginLower
}

var contentRepoNameRE = regexp.MustCompile(`(?i)(^|[-_.])(datasets?|awesome|papers?|books?|cheat-?sheets?|prompts?)([-_.]|$)`)
var contentRepoTopicRE = regexp.MustCompile(`(?i)^(datasets?|awesome|awesome-lists?|books?|courses?|tutorials?|notes|docs|documentation|papers?|cheatsheets?|prompts?)$`)
var nonCodeLanguages = map[string]bool{
	"asciidoc": true, "css": true, "html": true, "markdown": true, "mdx": true,
	"restructuredtext": true, "rich text format": true, "roff": true, "tex": true, "text": true,
}

// isContentLikeOriginalRepo mirrors isContentLikeOriginalRepo: datasets,
// lists, books and prose collections by name, topic, or >=80% non-code bytes.
func isContentLikeOriginalRepo(repo TopRepo) bool {
	if contentRepoNameRE.MatchString(repo.Name) {
		return true
	}
	for _, topic := range repo.Topics {
		if contentRepoTopicRE.MatchString(topic) {
			return true
		}
	}
	total, nonCode := 0.0, 0.0
	for _, language := range repo.Languages {
		total += max(0, language.Size)
	}
	if total <= 0 {
		return false
	}
	for _, language := range repo.Languages {
		if nonCodeLanguages[strings.ToLower(language.Name)] {
			nonCode += max(0, language.Size)
		}
	}
	return nonCode/total >= 0.8
}

// Star liveness: full weight when pushed within 12 months, falling linearly
// to 0.5 at 36 months. Runtime vars keep float math identical to TypeScript.
var (
	starLivenessFullMonths  = 12.0
	starLivenessFloorMonths = 36.0
	starLivenessFloor       = 0.5
	contentRepoStarWeight   = 0.6
	monthMillis             = (365.25 / 12) * 24 * 60 * 60 * 1000
)

// OriginalRepoStarWeight mirrors originalRepoStarWeight in src/lib/github.ts.
func OriginalRepoStarWeight(repo TopRepo, now time.Time) float64 {
	liveness := 1.0
	if pushed, ok := parseTimestamp(repo.PushedAt); ok {
		months := max(0, float64(now.UnixMilli()-pushed.UnixMilli())/monthMillis)
		stale := min(max((months-starLivenessFullMonths)/(starLivenessFloorMonths-starLivenessFullMonths), 0), 1)
		liveness = 1 - (1-starLivenessFloor)*stale
	}
	if isContentLikeOriginalRepo(repo) {
		return liveness * contentRepoStarWeight
	}
	return liveness * 1
}

// WeightedOriginalStars mirrors weightedOriginalStars: liveness- and
// kind-weighted star total and maximum over the scored originals.
func WeightedOriginalStars(repos []TopRepo, now time.Time) (float64, float64) {
	total, maximum := 0.0, 0.0
	for _, repo := range repos {
		weighted := max(0, repo.Stars) * OriginalRepoStarWeight(repo, now)
		total += weighted
		maximum = max(maximum, weighted)
	}
	return roundJS(total*100) / 100, roundJS(maximum*100) / 100
}
