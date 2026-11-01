package backend

import (
	"context"
	"fmt"
	"strings"
)

// These are the pre-v7 quick inventory/window bounds, not account-specific
// thresholds. Full collection removes the quick page/window limits.
const quickRepoPages = 2
const githubPageSize = 100
const mergedPRWindow = 300

type CollectionCoverage struct {
	Mode              string   `json:"mode"`
	Coverage          string   `json:"coverage"`
	TruncationReasons []string `json:"truncation_reasons"`
}

func scanCoverage(scan ScanResult) string {
	if scan.Collection != nil {
		return scan.Collection.Coverage
	}
	return "quick" // historical snapshots have no completeness evidence
}

// List originals server-side: REST type=owner alone still includes forks.
// Keep the cheap fork count so filtering cannot erase the footprint signal.
func (c *GitHubClient) ownedOriginalInventory(ctx context.Context, login string, full bool) ([]githubRepo, float64, bool, error) {
	return c.ownedOriginalInventorySince(ctx, login, full, "")
}

// ownedOriginalInventorySince lists originals with pushedAt strictly after
// since. An empty since is the existing full or quick page. The caller
// merges the delta into the stored snapshot; this function does not.
func (c *GitHubClient) ownedOriginalInventorySince(ctx context.Context, login string, full bool, since string) ([]githubRepo, float64, bool, error) {
	repos := []githubRepo{}
	var after *string
	forks := 0.0
	incremental := strings.TrimSpace(since) != ""
	for page := 0; full || incremental || page < quickRepoPages; page++ {
		var result struct {
			User *struct {
				Forks struct {
					TotalCount float64 `json:"totalCount"`
				} `json:"forks"`
				Repositories *struct {
					Nodes []struct {
						Name            string  `json:"name"`
						NameWithOwner   string  `json:"nameWithOwner"`
						IsFork          bool    `json:"isFork"`
						DiskUsage       float64 `json:"diskUsage"`
						StargazerCount  float64 `json:"stargazerCount"`
						ForkCount       float64 `json:"forkCount"`
						Description     *string `json:"description"`
						PushedAt        *string `json:"pushedAt"`
						PrimaryLanguage *struct {
							Name string `json:"name"`
						} `json:"primaryLanguage"`
						Issues struct {
							TotalCount float64 `json:"totalCount"`
						} `json:"issues"`
						OpenPullRequests struct {
							TotalCount float64 `json:"totalCount"`
						} `json:"openPullRequests"`
						RepositoryTopics struct {
							Nodes []struct {
								Topic struct {
									Name string `json:"name"`
								} `json:"topic"`
							} `json:"nodes"`
						} `json:"repositoryTopics"`
					} `json:"nodes"`
					PageInfo graphPageInfo `json:"pageInfo"`
				} `json:"repositories"`
			} `json:"user"`
		}
		query := `query OriginalInventory($login: String!, $after: String, $count: Int!) {
 user(login: $login) {
  forks: repositories(first: 1, privacy: PUBLIC, ownerAffiliations: [OWNER], isFork: true) { totalCount }
  repositories(first: $count, after: $after, privacy: PUBLIC, ownerAffiliations: [OWNER], isFork: false, orderBy: {field: PUSHED_AT, direction: DESC}) {
   nodes { name nameWithOwner isFork diskUsage stargazerCount forkCount description pushedAt primaryLanguage { name } issues(states: OPEN) { totalCount } openPullRequests: pullRequests(states: OPEN) { totalCount } repositoryTopics(first: 20) { nodes { topic { name } } } }
   pageInfo { hasNextPage endCursor }
  }
 }
}`
		if err := c.graphql(ctx, query, map[string]any{"login": login, "after": after, "count": githubPageSize}, &result); err != nil {
			return nil, 0, false, err
		}
		if result.User == nil || result.User.Repositories == nil {
			return nil, 0, false, ErrGitHubUnavailable
		}
		forks = result.User.Forks.TotalCount
		connection := result.User.Repositories
		pageRepos := make([]githubRepo, 0, len(connection.Nodes))
		for _, node := range connection.Nodes {
			if node.IsFork {
				continue
			}
			// REST open_issues_count includes open PRs; preserve that fact when
			// switching inventories so quality inputs do not drift incidentally.
			repo := githubRepo{Name: node.Name, FullName: node.NameWithOwner, Size: node.DiskUsage, StargazersCount: node.StargazerCount, ForksCount: node.ForkCount, OpenIssuesCount: node.Issues.TotalCount + node.OpenPullRequests.TotalCount, Description: node.Description, PushedAt: node.PushedAt}
			if node.PrimaryLanguage != nil {
				repo.Language = stringPointer(node.PrimaryLanguage.Name)
			}
			for _, topic := range node.RepositoryTopics.Nodes {
				repo.Topics = append(repo.Topics, topic.Topic.Name)
			}
			pageRepos = append(pageRepos, repo)
		}
		if incremental {
			stopped := false
			for _, repo := range pageRepos {
				// Equal timestamps stay. The merge dedupes by repo id, so a
				// second item pushed in the same second is not dropped.
				if repo.PushedAt == nil || cursorBeforeWatermark(*repo.PushedAt, since) {
					stopped = true
					continue
				}
				repos = append(repos, repo)
			}
			if stopped || !connection.PageInfo.HasNextPage {
				return repos, forks, false, nil
			}
		} else {
			repos = append(repos, pageRepos...)
		}
		if !connection.PageInfo.HasNextPage {
			return repos, forks, false, nil
		}
		if len(connection.Nodes) == 0 || connection.PageInfo.EndCursor == nil || *connection.PageInfo.EndCursor == "" || (after != nil && *after == *connection.PageInfo.EndCursor) {
			return nil, 0, false, fmt.Errorf("original inventory cursor: %w", ErrGitHubUnavailable)
		}
		after = connection.PageInfo.EndCursor
	}
	return repos, forks, true, nil
}

// Per-source state is never shared by the concurrent source jobs.
type collectionScope struct {
	Full    bool
	Reasons []string
}

func (s *collectionScope) note(reason string) {
	if s != nil {
		for _, r := range s.Reasons {
			if r == reason {
				return
			}
		}
		s.Reasons = append(s.Reasons, reason)
	}
}
func sourceScope(scopes []*collectionScope) *collectionScope {
	if len(scopes) > 0 {
		return scopes[0]
	}
	return &collectionScope{}
}
