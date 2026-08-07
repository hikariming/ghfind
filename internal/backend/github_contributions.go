package backend

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type contribStats struct {
	TotalCommitContributions            float64 `json:"totalCommitContributions"`
	TotalPullRequestContributions       float64 `json:"totalPullRequestContributions"`
	TotalIssueContributions             float64 `json:"totalIssueContributions"`
	TotalPullRequestReviewContributions float64 `json:"totalPullRequestReviewContributions"`
}

type contributionOverview struct {
	PinnedRepos       []string
	MergedPRCount     float64
	AllPRCount        float64
	ClosedPRCount     float64
	ClosedPRNodes     []ClosedPRNode
	IssuesCreated     float64
	ContributionYears []int
}

const contributionOverviewFields = `pinnedItems(first: 6, types: REPOSITORY) {
  nodes { ... on Repository { nameWithOwner } }
}
mergedPRs: pullRequests(states: MERGED) { totalCount }
allPRs: pullRequests { totalCount }
closedPRs: pullRequests(states: CLOSED, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
  totalCount
  nodes {
    id author { login } repository { owner { login } }
    timelineItems(last: 1, itemTypes: CLOSED_EVENT) { nodes { ... on ClosedEvent { actor { login } } } }
  }
}
issues { totalCount }
contributionYears: contributionsCollection { contributionYears }`

type graphClosedPRNode struct {
	ID     string `json:"id"`
	Author *struct {
		Login *string `json:"login"`
	} `json:"author"`
	Repository *struct {
		Owner *struct {
			Login *string `json:"login"`
		} `json:"owner"`
	} `json:"repository"`
	TimelineItems *struct {
		Nodes []struct {
			Actor *struct {
				Login *string `json:"login"`
			} `json:"actor"`
		} `json:"nodes"`
	} `json:"timelineItems"`
}

type graphOverviewUser struct {
	PinnedItems *struct {
		Nodes []struct {
			NameWithOwner *string `json:"nameWithOwner"`
		} `json:"nodes"`
	} `json:"pinnedItems"`
	MergedPRs *struct {
		TotalCount float64 `json:"totalCount"`
	} `json:"mergedPRs"`
	AllPRs *struct {
		TotalCount float64 `json:"totalCount"`
	} `json:"allPRs"`
	ClosedPRs *struct {
		TotalCount float64             `json:"totalCount"`
		Nodes      []graphClosedPRNode `json:"nodes"`
	} `json:"closedPRs"`
	Issues *struct {
		TotalCount float64 `json:"totalCount"`
	} `json:"issues"`
	ContributionYears *struct {
		ContributionYears []int `json:"contributionYears"`
	} `json:"contributionYears"`
	ContributionsCollection *struct {
		TotalCommitContributions            float64 `json:"totalCommitContributions"`
		TotalPullRequestContributions       float64 `json:"totalPullRequestContributions"`
		TotalIssueContributions             float64 `json:"totalIssueContributions"`
		TotalPullRequestReviewContributions float64 `json:"totalPullRequestReviewContributions"`
		ContributionCalendar                *struct {
			TotalContributions float64 `json:"totalContributions"`
		} `json:"contributionCalendar"`
	} `json:"contributionsCollection"`
}

func mapContributionOverview(user *graphOverviewUser) contributionOverview {
	result := contributionOverview{}
	if user == nil {
		return result
	}
	if user.PinnedItems != nil {
		for _, node := range user.PinnedItems.Nodes {
			if node.NameWithOwner != nil && *node.NameWithOwner != "" {
				result.PinnedRepos = append(result.PinnedRepos, *node.NameWithOwner)
			}
		}
	}
	if user.MergedPRs != nil {
		result.MergedPRCount = user.MergedPRs.TotalCount
	}
	if user.AllPRs != nil {
		result.AllPRCount = user.AllPRs.TotalCount
	}
	if user.ClosedPRs != nil {
		result.ClosedPRCount = user.ClosedPRs.TotalCount
		for _, node := range user.ClosedPRs.Nodes {
			mapped := ClosedPRNode{ID: node.ID}
			if node.Author != nil {
				mapped.AuthorLogin = node.Author.Login
			}
			if node.Repository != nil && node.Repository.Owner != nil {
				mapped.RepositoryOwner = node.Repository.Owner.Login
			}
			if node.TimelineItems != nil && len(node.TimelineItems.Nodes) > 0 && node.TimelineItems.Nodes[0].Actor != nil {
				mapped.ClosedBy = node.TimelineItems.Nodes[0].Actor.Login
			}
			result.ClosedPRNodes = append(result.ClosedPRNodes, mapped)
		}
	}
	if user.Issues != nil {
		result.IssuesCreated = user.Issues.TotalCount
	}
	if user.ContributionYears != nil {
		result.ContributionYears = append([]int(nil), user.ContributionYears.ContributionYears...)
	}
	return result
}

func (c *GitHubClient) fetchContributionOverview(ctx context.Context, username string) (contributionOverview, *contribStats, float64, error) {
	fullQuery := `query($login: String!) { user(login: $login) { ` + contributionOverviewFields + ` contributionsCollection {
totalCommitContributions totalPullRequestContributions totalIssueContributions totalPullRequestReviewContributions contributionCalendar { totalContributions }
} } }`
	var full struct {
		User *graphOverviewUser `json:"user"`
	}
	err := c.graphql(ctx, fullQuery, map[string]any{"login": username}, &full)
	if err == nil {
		if full.User == nil {
			return contributionOverview{}, nil, 0, fmt.Errorf("GitHub contribution data: %w", ErrGitHubUnavailable)
		}
		var stats *contribStats
		lastYear := 0.0
		if collection := full.User.ContributionsCollection; collection != nil {
			stats = &contribStats{
				TotalCommitContributions:            collection.TotalCommitContributions,
				TotalPullRequestContributions:       collection.TotalPullRequestContributions,
				TotalIssueContributions:             collection.TotalIssueContributions,
				TotalPullRequestReviewContributions: collection.TotalPullRequestReviewContributions,
			}
			if collection.ContributionCalendar != nil {
				lastYear = collection.ContributionCalendar.TotalContributions
			}
		}
		return mapContributionOverview(full.User), stats, lastYear, nil
	}
	if !errors.Is(err, ErrGitHubResourceLimit) {
		return contributionOverview{}, nil, 0, err
	}
	return c.fetchContributionOverviewFallback(ctx, username)
}

func (c *GitHubClient) fetchContributionOverviewFallback(ctx context.Context, username string) (contributionOverview, *contribStats, float64, error) {
	var overview struct {
		User *graphOverviewUser `json:"user"`
	}
	if err := c.graphql(ctx, `query($login: String!) { user(login: $login) { `+contributionOverviewFields+` } }`, map[string]any{"login": username}, &overview); err != nil {
		return contributionOverview{}, nil, 0, err
	}
	var calendar struct {
		User *struct {
			ContributionsCollection *struct {
				ContributionCalendar *struct {
					TotalContributions float64 `json:"totalContributions"`
				} `json:"contributionCalendar"`
			} `json:"contributionsCollection"`
		} `json:"user"`
	}
	if err := c.graphql(ctx, `query($login: String!) { user(login: $login) { contributionsCollection { contributionCalendar { totalContributions } } } }`, map[string]any{"login": username}, &calendar); err != nil {
		return contributionOverview{}, nil, 0, err
	}
	if overview.User == nil {
		return contributionOverview{}, nil, 0, fmt.Errorf("GitHub contribution data: %w", ErrGitHubUnavailable)
	}
	lastYear := 0.0
	if calendar.User != nil && calendar.User.ContributionsCollection != nil && calendar.User.ContributionsCollection.ContributionCalendar != nil {
		lastYear = calendar.User.ContributionsCollection.ContributionCalendar.TotalContributions
	}
	return mapContributionOverview(overview.User), nil, lastYear, nil
}

func (c *GitHubClient) fetchOrganizations(ctx context.Context, username string) ([]string, error) {
	var result struct {
		User *struct {
			Organizations *struct {
				Nodes []struct {
					Login *string `json:"login"`
				} `json:"nodes"`
			} `json:"organizations"`
		} `json:"user"`
	}
	err := c.graphql(ctx, `query($login: String!) { user(login: $login) { organizations(first: 20) { nodes { login } } } }`, map[string]any{"login": username}, &result)
	if err != nil {
		// Membership is a copy/attribution enrichment. Preserve the baseline
		// except when GitHub confirms the account-wide quota is exhausted.
		if errors.Is(err, ErrGitHubRateLimited) {
			return nil, err
		}
		return []string{}, nil
	}
	organizations := []string{}
	if result.User != nil && result.User.Organizations != nil {
		for _, node := range result.User.Organizations.Nodes {
			if node.Login != nil && *node.Login != "" {
				organizations = append(organizations, *node.Login)
			}
		}
	}
	return organizations, nil
}

func activityTypeCount(stats *contribStats, lastYear, allPRs, issues float64) float64 {
	if stats == nil {
		count := 0.0
		for _, hasSignal := range []bool{lastYear > 0, allPRs > 0, issues > 0} {
			if hasSignal {
				count++
			}
		}
		return count
	}
	count := 0.0
	for _, value := range []float64{stats.TotalCommitContributions, stats.TotalPullRequestContributions, stats.TotalIssueContributions, stats.TotalPullRequestReviewContributions} {
		if value > 0 {
			count++
		}
	}
	return count
}

func ownerLoginFromRepo(repo string) string {
	owner, _, found := strings.Cut(repo, "/")
	if !found {
		return ""
	}
	return owner
}

type graphPRNode struct {
	Title        *string  `json:"title"`
	Additions    *float64 `json:"additions"`
	Deletions    *float64 `json:"deletions"`
	ChangedFiles *float64 `json:"changedFiles"`
	Repository   *struct {
		NameWithOwner  *string `json:"nameWithOwner"`
		StargazerCount float64 `json:"stargazerCount"`
		IsPrivate      bool    `json:"isPrivate"`
	} `json:"repository"`
	Files *struct {
		Nodes []struct {
			Path *string `json:"path"`
		} `json:"nodes"`
	} `json:"files"`
}

func mapRecentPR(node graphPRNode) RecentPR {
	additions, deletions := valueOrZero(node.Additions), valueOrZero(node.Deletions)
	pr := RecentPR{
		Title:        node.Title,
		Churn:        additions + deletions,
		ChangedFiles: valueOrZero(node.ChangedFiles),
		Trivial:      additions+deletions <= 5,
	}
	if node.Repository != nil {
		pr.Repo, pr.RepoStars = node.Repository.NameWithOwner, node.Repository.StargazerCount
	}
	if node.Files != nil {
		for _, file := range node.Files.Nodes {
			if file.Path != nil && *file.Path != "" {
				pr.Files = append(pr.Files, *file.Path)
			}
		}
	}
	return pr
}

func (c *GitHubClient) fetchRecentPRs(ctx context.Context, username string, count int) ([]RecentPR, error) {
	var result struct {
		User *struct {
			PullRequests *struct {
				Nodes []graphPRNode `json:"nodes"`
			} `json:"pullRequests"`
		} `json:"user"`
	}
	query := `query($login: String!, $count: Int!) {
  user(login: $login) {
    pullRequests(first: $count, states: MERGED, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        title additions deletions changedFiles
        repository { nameWithOwner stargazerCount isPrivate }
        files(first: 50) { nodes { path } }
      }
    }
  }
}`
	if err := c.graphql(ctx, query, map[string]any{"login": username, "count": count}, &result); err != nil {
		return nil, err
	}
	if result.User == nil || result.User.PullRequests == nil {
		return nil, fmt.Errorf("GitHub PR data: %w", ErrGitHubUnavailable)
	}
	prs := make([]RecentPR, 0, len(result.User.PullRequests.Nodes))
	for _, node := range result.User.PullRequests.Nodes {
		prs = append(prs, mapRecentPR(node))
	}
	return prs, nil
}

func (c *GitHubClient) fetchRecentAllPRs(ctx context.Context, username string, count int) ([]AnyPR, error) {
	var result struct {
		User *struct {
			PullRequests *struct {
				Nodes []struct {
					Title      *string `json:"title"`
					Repository *struct {
						NameWithOwner *string `json:"nameWithOwner"`
					} `json:"repository"`
				} `json:"nodes"`
			} `json:"pullRequests"`
		} `json:"user"`
	}
	query := `query($login: String!, $count: Int!) {
  user(login: $login) {
    pullRequests(first: $count, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { title repository { nameWithOwner } }
    }
  }
}`
	if err := c.graphql(ctx, query, map[string]any{"login": username, "count": count}, &result); err != nil {
		return nil, err
	}
	if result.User == nil || result.User.PullRequests == nil {
		return nil, fmt.Errorf("GitHub all-PR data: %w", ErrGitHubUnavailable)
	}
	prs := []AnyPR{}
	for _, node := range result.User.PullRequests.Nodes {
		if node.Title != nil && node.Repository != nil && node.Repository.NameWithOwner != nil {
			prs = append(prs, AnyPR{Title: *node.Title, Repo: *node.Repository.NameWithOwner})
		}
	}
	return prs, nil
}
