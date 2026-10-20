package backend

import (
	"context"
	"math"
	"net/url"
	"regexp"
	"strings"
)

type CoCreatorFacts struct {
	UserCommits        float64 `json:"user_commits"`
	TotalCommits       float64 `json:"total_commits"`
	LeadingCommits     float64 `json:"leading_commits"`
	UserMergedPRs      float64 `json:"user_merged_prs"`
	TotalMergedPRs     float64 `json:"total_merged_prs"`
	ActiveYears        float64 `json:"active_years"`
	CoreChurn          float64 `json:"core_churn"`
	SampledChurn       float64 `json:"sampled_churn"`
	SubstantiveSamples float64 `json:"substantive_samples"`
	Samples            float64 `json:"samples"`
	Association        string  `json:"association,omitempty"`
	FirstAuthor        bool    `json:"first_author,omitempty"`
	ReleaseAuthor      bool    `json:"release_author,omitempty"`
	MaintainerFile     bool    `json:"maintainer_file,omitempty"`
	Pinned             bool    `json:"pinned,omitempty"`
	InflationSeverity  float64 `json:"inflation_severity,omitempty"`
}

func coUnit(x float64) float64   { return max(0, min(1, x)) }
func coSmooth(x float64) float64 { x = coUnit(x); return x * x * (3 - 2*x) }
func boolFloat(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
func coCreatorShare(f CoCreatorFacts) float64 {
	commitShare := coUnit(f.UserCommits / max(1, f.TotalCommits))
	rank := coUnit(f.UserCommits / max(1, f.LeadingCommits))
	prShare := coUnit(f.UserMergedPRs / max(1, f.TotalMergedPRs))
	role := boolFloat(f.Association == "OWNER" || f.Association == "MEMBER" || f.Association == "COLLABORATOR")
	dominance := .5*math.Sqrt(commitShare) + .2*rank + .3*math.Sqrt(prShare)
	identity := .35 + .2*role + .2*boolFloat(f.ReleaseAuthor) + .2*boolFloat(f.MaintainerFile) + .05*boolFloat(f.Pinned)
	if f.FirstAuthor {
		identity = 1
	}
	work := 1 - math.Exp(-math.Log1p(max(0, f.UserCommits)+3*max(0, f.UserMergedPRs))/2)
	tenure := .6 + .4*(1-math.Exp(-max(0, f.ActiveYears)/2))
	substance := (1 - math.Exp(-max(0, f.CoreChurn)/200)) * coSmooth(f.SubstantiveSamples/3)
	if f.FirstAuthor {
		return substance * coSmooth(math.Log1p(max(0, f.UserCommits)+3*max(0, f.UserMergedPRs))/math.Log(101)) * math.Exp(-3*coUnit(f.InflationSeverity))
	}
	confidence := max(0, f.Samples) / (max(0, f.Samples) + 2)
	return coSmooth(dominance * identity * work * tenure * substance * confidence * math.Exp(-3*coUnit(f.InflationSeverity)))
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
	owner, name, _ := strings.Cut(repo.Repo, "/")
	var contributors []struct {
		Login         string  `json:"login"`
		Contributions float64 `json:"contributions"`
	}
	_ = c.restGet(ctx, "repos/"+owner+"/"+name+"/contributors?per_page=100", &contributors)
	var data struct {
		Repository *struct {
			PullRequests struct {
				TotalCount float64 `json:"totalCount"`
			} `json:"pullRequests"`
			DefaultBranchRef *struct {
				Target *struct {
					History struct {
						TotalCount float64 `json:"totalCount"`
					} `json:"history"`
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
	}
	query := `query($owner: String!, $name: String!, $q: String!) { repository(owner: $owner, name: $name) { pullRequests(states: MERGED) { totalCount } defaultBranchRef { target { ... on Commit { history(first: 1) { totalCount } } } } } search(query: $q, type: ISSUE, first: 10) { issueCount nodes { ... on PullRequest { authorAssociation changedFiles files(first: 100) { nodes { path additions deletions } } } } } }`
	_ = c.graphql(ctx, query, map[string]any{"owner": owner, "name": name, "q": "repo:" + repo.Repo + " is:pr is:merged author:" + login + " sort:created-desc"}, &data)
	f := CoCreatorFacts{ActiveYears: repo.ActiveYears, UserMergedPRs: data.Search.IssueCount}
	for _, r := range contributors {
		f.TotalCommits += r.Contributions
		f.LeadingCommits = max(f.LeadingCommits, r.Contributions)
		if strings.EqualFold(r.Login, login) {
			f.UserCommits = r.Contributions
		}
	}
	if data.Repository != nil {
		f.TotalMergedPRs = data.Repository.PullRequests.TotalCount
		if d := data.Repository.DefaultBranchRef; d != nil && d.Target != nil {
			f.TotalCommits = max(f.TotalCommits, d.Target.History.TotalCount)
		}
	}
	corePattern := regexp.MustCompile(`\.(c|cc|cpp|cs|go|java|js|jsx|mjs|cjs|kt|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte|css|scss)$`)
	add := func(files []PRFileChange) {
		core, total := 0.0, 0.0
		for _, file := range files {
			churn := max(0, file.Additions) + max(0, file.Deletions)
			total += churn
			if corePattern.MatchString(file.Path) && !isPresentationPath(file.Path, repo.Repo, false) {
				core += churn
			}
		}
		f.Samples++
		f.CoreChurn += core
		f.SampledChurn += total
		if core > 5 {
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
