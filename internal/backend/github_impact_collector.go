package backend

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const impactYearCap = 6

type graphContributionRepo struct {
	NameWithOwner  string  `json:"nameWithOwner"`
	StargazerCount float64 `json:"stargazerCount"`
	IsPrivate      bool    `json:"isPrivate"`
	IsFork         bool    `json:"isFork"`
	Owner          *struct {
		Login *string `json:"login"`
	} `json:"owner"`
}

type graphCommitContribNode struct {
	Contributions *struct {
		TotalCount float64 `json:"totalCount"`
	} `json:"contributions"`
	Repository *graphContributionRepo `json:"repository"`
}

func contributionRepoFromGraph(repo *graphContributionRepo) ContribRepoAgg {
	if repo == nil {
		return ContribRepoAgg{}
	}
	owner := ownerLoginFromRepo(repo.NameWithOwner)
	if repo.Owner != nil && repo.Owner.Login != nil && *repo.Owner.Login != "" {
		owner = *repo.Owner.Login
	}
	return ContribRepoAgg{Repo: repo.NameWithOwner, Stars: repo.StargazerCount, IsPrivate: repo.IsPrivate, IsFork: repo.IsFork, OwnerLogin: owner}
}

// fetchCommitContribReposByYear mirrors the Node collector's bounded GraphQL
// aliases. GraphQL permits each contribution window to cover only one year.
func (c *GitHubClient) fetchCommitContribReposByYear(ctx context.Context, username string, years []int) ([]ContribRepoAgg, error) {
	unique := map[int]bool{}
	for _, year := range years {
		unique[year] = true
	}
	capped := make([]int, 0, len(unique))
	for year := range unique {
		capped = append(capped, year)
	}
	sort.Slice(capped, func(i, j int) bool { return capped[i] > capped[j] })
	if len(capped) > impactYearCap {
		capped = capped[:impactYearCap]
	}
	if len(capped) == 0 {
		return nil, nil
	}
	perYear, err := c.fetchCommitContribsBatch(ctx, username, capped)
	if errors.Is(err, ErrGitHubResourceLimit) && len(capped) > 1 {
		perYear = make([][]graphCommitContribNode, len(capped))
		for index, year := range capped {
			single, singleErr := c.fetchCommitContribsBatch(ctx, username, []int{year})
			if errors.Is(singleErr, ErrGitHubResourceLimit) {
				continue // Node behaviour: one pathological year does not fail the scan.
			}
			if singleErr != nil {
				return nil, singleErr
			}
			perYear[index] = single[0]
		}
	} else if err != nil {
		return nil, err
	}

	byRepo := map[string]ContribRepoAgg{}
	yearsByRepo := map[string]map[int]bool{}
	order := []string{}
	for index, nodes := range perYear {
		for _, node := range nodes {
			if node.Repository == nil || node.Repository.NameWithOwner == "" {
				continue
			}
			key := node.Repository.NameWithOwner
			current, found := byRepo[key]
			if !found {
				current = contributionRepoFromGraph(node.Repository)
				order = append(order, key)
			}
			current.Stars = max(current.Stars, node.Repository.StargazerCount)
			if node.Contributions != nil {
				current.Commits += node.Contributions.TotalCount
			}
			byRepo[key] = current
			if yearsByRepo[key] == nil {
				yearsByRepo[key] = map[int]bool{}
			}
			yearsByRepo[key][capped[index]] = true
		}
	}
	result := make([]ContribRepoAgg, 0, len(order))
	for _, key := range order {
		current := byRepo[key]
		current.ActiveYears = float64(len(yearsByRepo[key]))
		result = append(result, current)
	}
	return result, nil
}

func (c *GitHubClient) fetchCommitContribsBatch(ctx context.Context, username string, years []int) ([][]graphCommitContribNode, error) {
	declarations := []string{"$login: String!"}
	aliases := []string{}
	variables := map[string]any{"login": username}
	for index, year := range years {
		declarations = append(declarations, fmt.Sprintf("$from%d: DateTime!, $to%d: DateTime!", index, index))
		aliases = append(aliases, fmt.Sprintf("y%d: contributionsCollection(from: $from%d, to: $to%d) { ...RepoContribs }", index, index, index))
		variables[fmt.Sprintf("from%d", index)] = fmt.Sprintf("%d-01-01T00:00:00Z", year)
		variables[fmt.Sprintf("to%d", index)] = fmt.Sprintf("%d-12-31T23:59:59Z", year)
	}
	query := "query(" + strings.Join(declarations, ", ") + `) {
  user(login: $login) { ` + strings.Join(aliases, " ") + ` }
}
fragment RepoContribs on ContributionsCollection {
  commitContributionsByRepository(maxRepositories: 100) {
    contributions { totalCount }
    repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
  }
}`
	var result struct {
		User map[string]struct {
			CommitContributionsByRepository []graphCommitContribNode `json:"commitContributionsByRepository"`
		} `json:"user"`
	}
	if err := c.graphql(ctx, query, variables, &result); err != nil {
		return nil, err
	}
	if result.User == nil {
		return nil, fmt.Errorf("GitHub commit contributions: %w", ErrGitHubUnavailable)
	}
	pages := make([][]graphCommitContribNode, len(years))
	for index := range years {
		pages[index] = result.User[fmt.Sprintf("y%d", index)].CommitContributionsByRepository
	}
	return pages, nil
}

func (c *GitHubClient) fetchMergedPRContribRepos(ctx context.Context, username string, maxPRs int) ([]ContribRepoAgg, error) {
	byRepo := map[string]ContribRepoAgg{}
	yearsByRepo := map[string]map[int]bool{}
	order := []string{}
	var after *string
	counted := 0
	for counted < maxPRs {
		count := maxPRs - counted
		if count > 100 {
			count = 100
		}
		var result struct {
			User *struct {
				PullRequests *struct {
					Nodes []struct {
						MergedAt   *string                `json:"mergedAt"`
						Repository *graphContributionRepo `json:"repository"`
					} `json:"nodes"`
					PageInfo *struct {
						HasNextPage bool    `json:"hasNextPage"`
						EndCursor   *string `json:"endCursor"`
					} `json:"pageInfo"`
				} `json:"pullRequests"`
			} `json:"user"`
		}
		query := `query($login: String!, $count: Int!, $after: String) {
  user(login: $login) {
    pullRequests(first: $count, states: MERGED, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { mergedAt repository { nameWithOwner stargazerCount isPrivate isFork owner { login } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`
		if err := c.graphql(ctx, query, map[string]any{"login": username, "count": count, "after": after}, &result); err != nil {
			return nil, err
		}
		if result.User == nil || result.User.PullRequests == nil {
			return nil, fmt.Errorf("GitHub merged PR data: %w", ErrGitHubUnavailable)
		}
		for _, node := range result.User.PullRequests.Nodes {
			if node.Repository == nil || node.Repository.NameWithOwner == "" {
				continue
			}
			key := node.Repository.NameWithOwner
			current, found := byRepo[key]
			if !found {
				current = contributionRepoFromGraph(node.Repository)
				order = append(order, key)
			}
			current.Stars = max(current.Stars, node.Repository.StargazerCount)
			current.PRs++
			counted++
			byRepo[key] = current
			if merged, ok := parseTimestamp(node.MergedAt); ok {
				if yearsByRepo[key] == nil {
					yearsByRepo[key] = map[int]bool{}
				}
				yearsByRepo[key][merged.Year()] = true
			}
		}
		pageInfo := result.User.PullRequests.PageInfo
		if pageInfo == nil || !pageInfo.HasNextPage || pageInfo.EndCursor == nil || *pageInfo.EndCursor == "" {
			break
		}
		after = pageInfo.EndCursor
	}
	result := make([]ContribRepoAgg, 0, len(order))
	for _, key := range order {
		current := byRepo[key]
		current.ActiveYears = float64(len(yearsByRepo[key]))
		result = append(result, current)
	}
	return result, nil
}

// AccountAgeYears matches the two-decimal calculation from src/lib/github.ts.
func accountAgeYears(createdAt *string, now time.Time) float64 {
	created, ok := parseTimestamp(createdAt)
	if !ok {
		return 0
	}
	return roundJS(now.Sub(created).Hours()/24/365.25*100) / 100
}

func boundedContributionYearsActive(years []int, createdAt *string, now time.Time) float64 {
	active := map[int]bool{}
	for _, year := range years {
		active[year] = true
	}
	if len(active) == 0 {
		return 0
	}
	created, ok := parseTimestamp(createdAt)
	if !ok {
		return float64(len(active))
	}
	if now.Year() < created.Year() {
		return 0
	}
	count := 0.0
	for year := range active {
		if year >= created.Year() && year <= now.Year() {
			count++
		}
	}
	return count
}
