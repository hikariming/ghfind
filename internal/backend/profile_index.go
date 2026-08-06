package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
)

// DeveloperFacet and RepoGraph are the Go equivalents of the existing pure
// TypeScript profile-index helpers. They turn a persisted raw scan into the
// existing directory and project read models without introducing a new schema.
type DeveloperFacet struct {
	Type   string
	Value  string
	Weight float64
}

type RepoGraphNode struct {
	Key           string
	NameWithOwner string
	OwnerLogin    string
	Name          string
	Description   *string
	Stars         float64
	Forks         *float64
	Language      *string
	Topics        []string
}

type RepoGraphLink struct {
	Key      string
	Relation string
	Commits  *float64
	PRs      *float64
	Weight   float64
}

type RepoGraph struct {
	Nodes []RepoGraphNode
	Links []RepoGraphLink
}

var directoryLanguageExclusions = map[string]bool{
	"html": true, "css": true, "scss": true, "sass": true, "less": true,
	"stylus": true, "makefile": true, "cmake": true, "dockerfile": true,
	"batchfile": true, "shell": true, "powershell": true, "roff": true,
	"tex": true, "rich text format": true, "jupyter notebook": true,
	"vim snippet": true,
}

const (
	maxLanguagesPerDeveloper = 3
	maxOrganizationsPerDev   = 5
	maxFacetReposPerDev      = 6
	maxOwnerGraphRepos       = 10
	maxContribGraphRepos     = 20
	minimumFacetRepoStars    = 500.0
	minimumOwnerRepoStars    = 50.0
	minimumLanguagePercent   = 15.0
)

type languageSize struct {
	Name  string
	Size  float64
	Order int
}

// ExtractDeveloperFacets exactly follows src/lib/facets.ts, including its
// stable tie ordering and primary-language fallback for legacy snapshots.
func ExtractDeveloperFacets(scan ScanResult) []DeveloperFacet {
	facets := make([]DeveloperFacet, 0, 14)
	facets = append(facets, extractLanguageFacets(scan.TopRepos)...)
	facets = append(facets, extractOrganizationFacets(scan.Organizations)...)
	facets = append(facets, extractRepoFacets(scan.ImpactRepos)...)
	return facets
}

func extractLanguageFacets(repos []TopRepo) []DeveloperFacet {
	byName := map[string]*languageSize{}
	ordered := []*languageSize{}
	total := 0.0
	for _, repo := range repos {
		for _, language := range repo.Languages {
			if strings.TrimSpace(language.Name) == "" || language.Size <= 0 {
				continue
			}
			entry := byName[language.Name]
			if entry == nil {
				entry = &languageSize{Name: language.Name, Order: len(ordered)}
				byName[language.Name] = entry
				ordered = append(ordered, entry)
			}
			entry.Size += language.Size
			total += language.Size
		}
	}
	if total == 0 {
		for _, repo := range repos {
			if repo.Language == nil || strings.TrimSpace(*repo.Language) == "" {
				continue
			}
			entry := byName[*repo.Language]
			if entry == nil {
				entry = &languageSize{Name: *repo.Language, Order: len(ordered)}
				byName[*repo.Language] = entry
				ordered = append(ordered, entry)
			}
			entry.Size++
			total++
		}
	}
	if total == 0 {
		return []DeveloperFacet{}
	}
	sort.SliceStable(ordered, func(left, right int) bool { return ordered[left].Size > ordered[right].Size })
	if len(ordered) > 12 {
		ordered = ordered[:12]
	}
	real := make([]languageSize, 0, len(ordered))
	for _, entry := range ordered {
		if !directoryLanguageExclusions[strings.ToLower(strings.TrimSpace(entry.Name))] {
			real = append(real, *entry)
		}
	}
	if len(real) == 0 {
		return []DeveloperFacet{}
	}
	shareTotal := 0.0
	for index := range real {
		real[index].Size = roundJS(real[index].Size / total * 100)
		shareTotal += real[index].Size
	}
	if shareTotal == 0 {
		return []DeveloperFacet{}
	}
	facets := []DeveloperFacet{}
	for index, entry := range real {
		weight := roundJS(entry.Size / shareTotal * 100)
		if index != 0 && weight < minimumLanguagePercent {
			continue
		}
		facets = append(facets, DeveloperFacet{Type: "language", Value: entry.Name, Weight: weight})
		if len(facets) == maxLanguagesPerDeveloper {
			break
		}
	}
	return facets
}

func extractOrganizationFacets(organizations []string) []DeveloperFacet {
	seen, facets := map[string]bool{}, []DeveloperFacet{}
	for _, raw := range organizations {
		value := strings.TrimSpace(raw)
		key := strings.ToLower(value)
		if value == "" || seen[key] {
			continue
		}
		seen[key] = true
		facets = append(facets, DeveloperFacet{Type: "org", Value: value, Weight: 1})
		if len(facets) == maxOrganizationsPerDev {
			break
		}
	}
	return facets
}

func extractRepoFacets(repos []ImpactRepo) []DeveloperFacet {
	ranked := append([]ImpactRepo(nil), repos...)
	sort.SliceStable(ranked, func(left, right int) bool { return ranked[left].Stars > ranked[right].Stars })
	seen, facets := map[string]bool{}, []DeveloperFacet{}
	for _, repo := range ranked {
		value := strings.TrimSpace(repo.Repo)
		key := strings.ToLower(value)
		if !strings.Contains(value, "/") || repo.Stars < minimumFacetRepoStars || seen[key] {
			continue
		}
		seen[key] = true
		facets = append(facets, DeveloperFacet{Type: "repo", Value: value, Weight: repo.Stars})
		if len(facets) == maxFacetReposPerDev {
			break
		}
	}
	return facets
}

// ExtractRepoGraph exactly follows src/lib/repo-graph.ts. Owned projects win
// when the same key occurs in an impact aggregate because their metadata is
// richer and the ownership relation is the public product contract.
func ExtractRepoGraph(scan ScanResult) RepoGraph {
	owners := ownerGraph(scan.TopRepos)
	contributors := contributorGraph(scan.ImpactRepos)
	ownedKeys := map[string]bool{}
	for _, link := range owners.Links {
		ownedKeys[link.Key] = true
	}
	nodes := map[string]RepoGraphNode{}
	nodeOrder := []string{}
	for _, node := range contributors.Nodes {
		if _, exists := nodes[node.Key]; !exists {
			nodeOrder = append(nodeOrder, node.Key)
		}
		nodes[node.Key] = node
	}
	for _, node := range owners.Nodes {
		if _, exists := nodes[node.Key]; !exists {
			nodeOrder = append(nodeOrder, node.Key)
		}
		nodes[node.Key] = node
	}
	result := RepoGraph{Nodes: make([]RepoGraphNode, 0, len(nodeOrder)), Links: append([]RepoGraphLink(nil), owners.Links...)}
	for _, key := range nodeOrder {
		result.Nodes = append(result.Nodes, nodes[key])
	}
	for _, link := range contributors.Links {
		if !ownedKeys[link.Key] {
			result.Links = append(result.Links, link)
		}
	}
	return result
}

func ownerGraph(repos []TopRepo) RepoGraph {
	ranked := append([]TopRepo(nil), repos...)
	sort.SliceStable(ranked, func(left, right int) bool { return ranked[left].Stars > ranked[right].Stars })
	seen, result := map[string]bool{}, RepoGraph{}
	for _, repo := range ranked {
		if repo.Stars < minimumOwnerRepoStars {
			continue
		}
		nameWithOwner := valueOrString(repo.NameWithOwner, "")
		if nameWithOwner == "" && repo.OwnerLogin != nil {
			nameWithOwner = *repo.OwnerLogin + "/" + repo.Name
		}
		key, owner, name, ok := graphRepoKey(nameWithOwner)
		if !ok || seen[key] {
			continue
		}
		seen[key] = true
		ownerLogin := owner
		if repo.OwnerLogin != nil && *repo.OwnerLogin != "" {
			ownerLogin = strings.ToLower(*repo.OwnerLogin)
		}
		repoName := repo.Name
		if repoName == "" {
			repoName = name
		}
		result.Nodes = append(result.Nodes, RepoGraphNode{Key: key, NameWithOwner: strings.TrimSpace(nameWithOwner), OwnerLogin: ownerLogin, Name: repoName, Description: repo.Description, Stars: repo.Stars, Forks: floatPointerValue(repo.Forks), Language: repo.Language, Topics: append([]string(nil), repo.Topics...)})
		result.Links = append(result.Links, RepoGraphLink{Key: key, Relation: "owner", Weight: repo.Stars})
		if len(result.Nodes) == maxOwnerGraphRepos {
			break
		}
	}
	return result
}

func contributorGraph(repos []ImpactRepo) RepoGraph {
	ranked := append([]ImpactRepo(nil), repos...)
	sort.SliceStable(ranked, func(left, right int) bool { return ranked[left].Stars > ranked[right].Stars })
	seen, result := map[string]bool{}, RepoGraph{}
	for _, repo := range ranked {
		if repo.Stars < minimumFacetRepoStars {
			continue
		}
		key, owner, name, ok := graphRepoKey(repo.Repo)
		if !ok || seen[key] {
			continue
		}
		seen[key] = true
		commits, prs := repo.Commits, repo.PRs
		result.Nodes = append(result.Nodes, RepoGraphNode{Key: key, NameWithOwner: strings.TrimSpace(repo.Repo), OwnerLogin: owner, Name: name, Stars: repo.Stars, Topics: []string{}})
		result.Links = append(result.Links, RepoGraphLink{Key: key, Relation: "contributor", Commits: &commits, PRs: &prs, Weight: commits + prs})
		if len(result.Nodes) == maxContribGraphRepos {
			break
		}
	}
	return result
}

func graphRepoKey(raw string) (key, owner, name string, ok bool) {
	value := strings.TrimSpace(raw)
	parts := strings.Split(value, "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", "", false
	}
	return strings.ToLower(value), strings.ToLower(parts[0]), parts[1], true
}

func floatPointerValue(value float64) *float64 {
	copy := value
	return &copy
}

// materializeProfileIndexes is deliberately best-effort like the prior Next
// recordProfileSnapshot path. It runs only after the canonical scan transaction
// committed, so an index/schema outage cannot make the scan itself disappear.
func (s *TursoStore) materializeProfileIndexes(ctx context.Context, username string, scan ScanResult, scannedAt int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE scores SET followers = ?, total_stars = ? WHERE username = ?`, integerMetric(scan.Metrics.Followers), integerMetric(scan.Metrics.TotalStars), username); err != nil {
		return fmt.Errorf("update influence signals: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM developer_facets WHERE username = ?`, username); err != nil {
		return fmt.Errorf("clear developer facets: %w", err)
	}
	for _, facet := range ExtractDeveloperFacets(scan) {
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO developer_facets (username, facet_type, facet_value, weight) VALUES (?, ?, ?, ?)`, username, facet.Type, facet.Value, facet.Weight); err != nil {
			return fmt.Errorf("insert developer facet: %w", err)
		}
	}
	graph := ExtractRepoGraph(scan)
	for _, node := range graph.Nodes {
		nodeTopics := node.Topics
		if nodeTopics == nil {
			// The repos.topics contract is a JSON array; a nil slice would
			// persist the literal `null` and break array readers downstream.
			nodeTopics = []string{}
		}
		topics, err := json.Marshal(nodeTopics)
		if err != nil {
			return fmt.Errorf("encode repo topics: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO repos
          (repo_key, name_with_owner, owner_login, name, description, stars, forks, language, topics, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo_key) DO UPDATE SET
            name_with_owner = excluded.name_with_owner,
            owner_login = excluded.owner_login,
            name = excluded.name,
            description = COALESCE(excluded.description, repos.description),
            stars = MAX(repos.stars, excluded.stars),
            forks = COALESCE(excluded.forks, repos.forks),
            language = COALESCE(excluded.language, repos.language),
            topics = CASE WHEN excluded.topics <> '[]' THEN excluded.topics ELSE repos.topics END,
            updated_at = excluded.updated_at`,
			node.Key, node.NameWithOwner, node.OwnerLogin, node.Name, node.Description, integerMetric(node.Stars), nullableIntegerMetric(node.Forks), node.Language, string(topics), scannedAt); err != nil {
			return fmt.Errorf("upsert repo graph node: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM repo_developers WHERE username = ?`, username); err != nil {
		return fmt.Errorf("clear repo graph links: %w", err)
	}
	for _, link := range graph.Links {
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO repo_developers
          (repo_key, username, relation, commits, prs, weight, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, link.Key, username, link.Relation, nullableIntegerMetric(link.Commits), nullableIntegerMetric(link.PRs), link.Weight, scannedAt); err != nil {
			return fmt.Errorf("insert repo graph link: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit profile indexes: %w", err)
	}
	return nil
}

func integerMetric(value float64) int64 { return int64(math.Round(value)) }

func nullableIntegerMetric(value *float64) any {
	if value == nil {
		return nil
	}
	return integerMetric(*value)
}
