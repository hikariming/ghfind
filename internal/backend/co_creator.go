package backend

import (
	"context"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type CoCreatorFacts struct {
	UserCommits          float64  `json:"user_commits"`
	TotalCommits         float64  `json:"total_commits"`
	LeadingCommits       float64  `json:"leading_commits"`
	UserMergedPRs        float64  `json:"user_merged_prs"`
	TotalMergedPRs       float64  `json:"total_merged_prs"`
	ActiveYears          float64  `json:"active_years"`
	CoreChurn            float64  `json:"core_churn"`
	SampledChurn         float64  `json:"sampled_churn"`
	SubstantiveSamples   float64  `json:"substantive_samples"`
	Samples              float64  `json:"samples"`
	Association          string   `json:"association,omitempty"`
	FirstAuthor          bool     `json:"first_author,omitempty"`
	ReleaseAuthor        bool     `json:"release_author,omitempty"`
	MaintainerFile       bool     `json:"maintainer_file,omitempty"`
	Pinned               bool     `json:"pinned,omitempty"`
	InflationSeverity    float64  `json:"inflation_severity,omitempty"`
	RecentUserCommits    *float64 `json:"recent_user_commits,omitempty"`
	RecentTotalCommits   *float64 `json:"recent_total_commits,omitempty"`
	RecentUserMergedPRs  *float64 `json:"recent_user_merged_prs,omitempty"`
	RecentTotalMergedPRs *float64 `json:"recent_total_merged_prs,omitempty"`
	ReviewedPRs          *float64 `json:"reviewed_prs,omitempty"`
}

// Mirrors src/lib/co-creator.ts.
const (
	recentMaintenanceDays = 180
	contentChurnPerCommit = 100.0
	contentRoleMax        = 0.35
	roleFade              = 0.2
	inflationStrength     = 5.0
	shareFade             = 0.15
	rewriteWeight         = 0.1
	coreFileChurnCap      = 1500.0
	contributorPageLimit  = 3
)

func coUnit(x float64) float64   { return max(0, min(1, x)) }
func coSmooth(x float64) float64 { x = coUnit(x); return x * x * (3 - 2*x) }
func boolFloat(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
func coNZ(x *float64) float64 {
	if x == nil {
		return 0
	}
	return max(0, *x)
}

func lifetimeDominance(f CoCreatorFacts) float64 {
	commitShare := coUnit(f.UserCommits / max(1, f.TotalCommits))
	rank := coUnit(f.UserCommits / max(1, f.LeadingCommits))
	prShare := coUnit(f.UserMergedPRs / max(1, f.TotalMergedPRs))
	return .5*math.Sqrt(commitShare) + .2*rank + .3*math.Sqrt(prShare)
}

func maintenanceDominance(f CoCreatorFacts) float64 {
	rtc, rtp := coNZ(f.RecentTotalCommits), coNZ(f.RecentTotalMergedPRs)
	if rtc <= 0 && rtp <= 0 {
		return 0
	}
	rc := coUnit(coNZ(f.RecentUserCommits) / max(1, rtc))
	rp := coUnit(coNZ(f.RecentUserMergedPRs) / max(1, rtp))
	var base float64
	switch {
	case rtc > 0 && rtp > 0:
		base = .6*math.Sqrt(rc) + .4*math.Sqrt(rp)
	case rtc > 0:
		base = math.Sqrt(rc)
	default:
		base = math.Sqrt(rp)
	}
	review := coNZ(f.ReviewedPRs) / (coNZ(f.ReviewedPRs) + 20)
	volume := coSmooth(math.Log1p(coNZ(f.RecentUserCommits)+3*coNZ(f.RecentUserMergedPRs)) / math.Log(61))
	return coUnit(base+.1*review) * volume
}

func contentRole(f CoCreatorFacts) float64 {
	churn := max(0, f.CoreChurn)
	return min(contentRoleMax, churn/(churn+contentChurnPerCommit*max(1, f.TotalCommits))) * coSmooth(max(0, f.SubstantiveSamples)/3)
}

func coCreatorShare(f CoCreatorFacts) float64 {
	substance := (1 - math.Exp(-max(0, f.CoreChurn)/200)) * coSmooth(max(0, f.SubstantiveSamples)/3)
	inflation := math.Exp(-inflationStrength * coUnit(f.InflationSeverity))
	if f.FirstAuthor {
		return substance * coSmooth(math.Log1p(max(0, f.UserCommits)+3*max(0, f.UserMergedPRs))/math.Log(101)) * inflation
	}
	rawRole := max(lifetimeDominance(f), maintenanceDominance(f), contentRole(f))
	role := rawRole * coSmooth(rawRole/roleFade)
	association := boolFloat(f.Association == "OWNER" || f.Association == "MEMBER" || f.Association == "COLLABORATOR")
	identity := min(1, .7+.1*association+.1*boolFloat(f.ReleaseAuthor)+.1*boolFloat(f.MaintainerFile)+.05*boolFloat(f.Pinned))
	counted := max(0, f.UserCommits) + 3*max(0, f.UserMergedPRs)
	work := max(1-math.Exp(-math.Log1p(counted)/2), (1-math.Exp(-max(0, f.CoreChurn)/2000))*coSmooth(counted))
	tenure := .85 + .15*(1-math.Exp(-max(0, f.ActiveYears)/2))
	confidence := .6 + .4*max(0, f.Samples)/(max(0, f.Samples)+2)
	share := coUnit(role * identity * work * tenure * substance * confidence * inflation)
	return share * coSmooth(share/shareFade)
}

var (
	coreSourcePattern    = regexp.MustCompile(`\.(c|cc|cpp|cs|go|java|js|jsx|mjs|cjs|kt|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte|css|scss)$`)
	generatedPathPattern = regexp.MustCompile(`(^|/)(vendor|vendored|third[_-]?party|node_modules|dist|build|out|generated|__generated__|gen)/|\.(min\.js|pb\.go|pb\.gw\.go|pb\.ts|g\.dart|freezed\.dart|generated\.\w+)$|_pb2(_grpc)?\.py$|\.d\.ts$`)
	botLoginPattern      = regexp.MustCompile(`(?i)\[bot\]$|-bot$|^(dependabot|renovate|github-actions|copilot-swe-agent)`)
)

// weightedCoreChurn mirrors weightedCoreChurn in src/lib/co-creator.ts.
func weightedCoreChurn(files []PRFileChange, repo string) (float64, float64, float64) {
	core, total, fresh := 0.0, 0.0, 0.0
	for _, file := range files {
		a, d := max(0, file.Additions), max(0, file.Deletions)
		churn := a + d
		total += churn
		if !coreSourcePattern.MatchString(file.Path) || generatedPathPattern.MatchString(file.Path) || isPresentationPath(file.Path, repo, false) {
			continue
		}
		capped := min(coreFileChurnCap, churn)
		if a >= 20 && d >= 20 && math.Abs(a-d)/churn < 0.1 {
			core += capped * rewriteWeight
			continue
		}
		core += capped
		fresh += capped
	}
	return core, total, fresh
}

func isBotLogin(login, kind string) bool { return kind == "Bot" || botLoginPattern.MatchString(login) }

type contributorRow struct {
	Login         string  `json:"login"`
	Contributions float64 `json:"contributions"`
	Type          string  `json:"type"`
}

// summarizeContributors mirrors summarizeContributors in src/lib/co-creator.ts.
func summarizeContributors(rows []contributorRow, login string, truncated bool, historyTotal, fallbackUserCommits float64) (float64, float64, float64) {
	human, bots, leading := 0.0, 0.0, 0.0
	user, found := 0.0, false
	for _, row := range rows {
		n := max(0, row.Contributions)
		if isBotLogin(row.Login, row.Type) {
			bots += n
			continue
		}
		human += n
		leading = max(leading, n)
		if strings.EqualFold(row.Login, login) {
			user += n
			found = true
		}
	}
	history := max(0, historyTotal-bots)
	if !found && (truncated || len(rows) == 0) {
		user = max(0, fallbackUserCommits)
	}
	total := human
	if truncated || human == 0 {
		total = max(human, history)
	}
	return user, max(total, user), max(leading, user)
}

func projectShare(share *float64) float64 {
	if share == nil {
		return 1
	}
	return coUnit(*share)
}
func budgetCoCreatorShares(repos []TopRepo) []TopRepo {
	total := 0.0
	for _, r := range repos {
		if r.CoCreatorFacts == nil || !r.CoCreatorFacts.FirstAuthor {
			total += projectShare(r.AttributionShare)
		}
	}
	factor := 1.0
	if total > 0 {
		factor = 2 * math.Tanh(total/2) / total
	}
	for i := range repos {
		multiplier := factor
		if repos[i].CoCreatorFacts != nil && repos[i].CoCreatorFacts.FirstAuthor {
			multiplier = 1
		}
		s := projectShare(repos[i].AttributionShare) * multiplier
		repos[i].AttributionShare = &s
	}
	return repos
}
func (c *GitHubClient) collectCoCreatorFacts(ctx context.Context, repo ContribRepoAgg, login string) CoCreatorFacts {
	return c.collectCoCreatorFactsAt(ctx, repo, login, time.Now())
}

// collectCoCreatorFactsAt mirrors collectCoCreatorFacts in src/lib/github.ts.
func (c *GitHubClient) collectCoCreatorFactsAt(ctx context.Context, repo ContribRepoAgg, login string, now time.Time) CoCreatorFacts {
	owner, name, _ := strings.Cut(repo.Repo, "/")
	// Page the contributor list until the user appears (bounded): large repos
	// otherwise report 0 commits for anyone ranked past the first 100.
	rows, truncated := []contributorRow{}, false
	for page := 1; page <= contributorPageLimit; page++ {
		var batch []contributorRow
		_ = c.restGet(ctx, "repos/"+owner+"/"+name+"/contributors?per_page=100&page="+strconv.Itoa(page), &batch)
		rows = append(rows, batch...)
		truncated = len(batch) >= 100
		found := false
		for _, row := range batch {
			if strings.EqualFold(row.Login, login) {
				found = true
			}
		}
		if !truncated || found {
			break
		}
	}
	sinceISO := now.UTC().Add(-recentMaintenanceDays * 24 * time.Hour).Format("2006-01-02T15:04:05.000Z")
	sinceDay := sinceISO[:10]
	type countNode struct {
		TotalCount float64 `json:"totalCount"`
	}
	type issueCount struct {
		IssueCount float64 `json:"issueCount"`
	}
	var data struct {
		User *struct {
			ID string `json:"id"`
		} `json:"user"`
		Repository *struct {
			PullRequests     countNode `json:"pullRequests"`
			DefaultBranchRef *struct {
				Target *struct {
					History countNode  `json:"history"`
					Recent  *countNode `json:"recent"`
				} `json:"target"`
			} `json:"defaultBranchRef"`
		} `json:"repository"`
		Search struct {
			IssueCount float64 `json:"issueCount"`
			Nodes      []struct {
				AuthorAssociation string `json:"authorAssociation"`
				ChangedFiles      int    `json:"changedFiles"`
				Files             struct {
					Nodes []PRFileChange `json:"nodes"`
				} `json:"files"`
			} `json:"nodes"`
		} `json:"search"`
		RecentAll  *issueCount `json:"recentAll"`
		RecentMine *issueCount `json:"recentMine"`
		Reviewed   *issueCount `json:"reviewed"`
	}
	query := `query($owner: String!, $name: String!, $q: String!, $since: GitTimestamp!, $recentAll: String!, $recentMine: String!, $reviewed: String!, $login: String!) { user(login: $login) { id } repository(owner: $owner, name: $name) { pullRequests(states: MERGED) { totalCount } defaultBranchRef { target { ... on Commit { history(first: 1) { totalCount } recent: history(since: $since) { totalCount } } } } } search(query: $q, type: ISSUE, first: 10) { issueCount nodes { ... on PullRequest { authorAssociation changedFiles files(first: 100) { nodes { path additions deletions } } } } } recentAll: search(query: $recentAll, type: ISSUE) { issueCount } recentMine: search(query: $recentMine, type: ISSUE) { issueCount } reviewed: search(query: $reviewed, type: ISSUE) { issueCount } }`
	_ = c.graphql(ctx, query, map[string]any{
		"owner": owner, "name": name, "login": login, "since": sinceISO,
		"q":          "repo:" + repo.Repo + " is:pr is:merged author:" + login + " sort:created-desc",
		"recentAll":  "repo:" + repo.Repo + " is:pr is:merged merged:>=" + sinceDay,
		"recentMine": "repo:" + repo.Repo + " is:pr is:merged merged:>=" + sinceDay + " author:" + login,
		"reviewed":   "repo:" + repo.Repo + " is:pr reviewed-by:" + login + " -author:" + login,
	}, &data)
	historyTotal := 0.0
	var recentTotal *float64
	f := CoCreatorFacts{ActiveYears: repo.ActiveYears, UserMergedPRs: data.Search.IssueCount}
	if data.Repository != nil {
		f.TotalMergedPRs = data.Repository.PullRequests.TotalCount
		if d := data.Repository.DefaultBranchRef; d != nil && d.Target != nil {
			historyTotal = d.Target.History.TotalCount
			if d.Target.Recent != nil {
				recentTotal = &d.Target.Recent.TotalCount
			}
		}
	}
	f.UserCommits, f.TotalCommits, f.LeadingCommits = summarizeContributors(rows, login, truncated, historyTotal, repo.Commits)
	if data.User != nil && data.User.ID != "" && recentTotal != nil {
		var mine struct {
			Repository *struct {
				DefaultBranchRef *struct {
					Target *struct {
						History *countNode `json:"history"`
					} `json:"target"`
				} `json:"defaultBranchRef"`
			} `json:"repository"`
		}
		mineQuery := `query($owner: String!, $name: String!, $since: GitTimestamp!, $id: ID!) { repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit { history(since: $since, author: {id: $id}) { totalCount } } } } } }`
		if c.graphql(ctx, mineQuery, map[string]any{"owner": owner, "name": name, "since": sinceISO, "id": data.User.ID}, &mine) == nil &&
			mine.Repository != nil && mine.Repository.DefaultBranchRef != nil && mine.Repository.DefaultBranchRef.Target != nil && mine.Repository.DefaultBranchRef.Target.History != nil {
			userRecent := mine.Repository.DefaultBranchRef.Target.History.TotalCount
			totalRecent := max(*recentTotal, userRecent)
			f.RecentUserCommits, f.RecentTotalCommits = &userRecent, &totalRecent
		}
	}
	if data.RecentAll != nil && data.RecentMine != nil {
		userPRs, totalPRs := data.RecentMine.IssueCount, max(data.RecentAll.IssueCount, data.RecentMine.IssueCount)
		f.RecentUserMergedPRs, f.RecentTotalMergedPRs = &userPRs, &totalPRs
	}
	if data.Reviewed != nil {
		reviewed := data.Reviewed.IssueCount
		f.ReviewedPRs = &reviewed
	}
	add := func(files []PRFileChange) {
		core, total, fresh := weightedCoreChurn(files, repo.Repo)
		f.Samples++
		f.CoreChurn += core
		f.SampledChurn += total
		if fresh > 5 {
			f.SubstantiveSamples++
		}
	}
	for _, pr := range data.Search.Nodes {
		if pr.AuthorAssociation == "OWNER" || pr.AuthorAssociation == "MEMBER" || pr.AuthorAssociation == "COLLABORATOR" {
			f.Association = pr.AuthorAssociation
		}
		if len(pr.Files.Nodes) > 0 && len(pr.Files.Nodes) >= pr.ChangedFiles {
			add(pr.Files.Nodes)
		}
	}
	if f.Samples < 3 {
		var commits []struct {
			SHA     string `json:"sha"`
			Parents []any  `json:"parents"`
		}
		_ = c.restGet(ctx, "repos/"+owner+"/"+name+"/commits?author="+url.QueryEscape(login)+"&per_page=3", &commits)
		for _, commit := range commits {
			if len(commit.Parents) > 1 {
				continue
			}
			var detail struct {
				Files []struct {
					Filename  string  `json:"filename"`
					Additions float64 `json:"additions"`
					Deletions float64 `json:"deletions"`
				} `json:"files"`
				Stats *struct {
					Total float64 `json:"total"`
				} `json:"stats"`
			}
			if c.restGet(ctx, "repos/"+owner+"/"+name+"/commits/"+commit.SHA, &detail) != nil {
				continue
			}
			files := []PRFileChange{}
			total := 0.0
			for _, file := range detail.Files {
				files = append(files, PRFileChange{Path: file.Filename, Additions: file.Additions, Deletions: file.Deletions})
				total += file.Additions + file.Deletions
			}
			if len(files) > 0 && detail.Stats != nil && total == detail.Stats.Total {
				add(files)
			}
		}
	}
	return f
}
