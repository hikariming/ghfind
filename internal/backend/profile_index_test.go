package backend

import (
	"fmt"
	"strings"
	"testing"
)

func TestExtractDeveloperFacetsPreservesDirectoryRules(t *testing.T) {
	scan := ScanResult{
		TopRepos:      []TopRepo{{Languages: []RepoLanguage{{Name: "TypeScript", Size: 50}, {Name: "HTML", Size: 30}, {Name: "CSS", Size: 20}}}},
		Organizations: []string{"huggingface", "HuggingFace", "pytorch"},
		ImpactRepos:   []ImpactRepo{{Repo: "langgenius/dify", Stars: 60000}, {Repo: "tiny/lib", Stars: 499}},
	}
	facets := ExtractDeveloperFacets(scan)
	if len(facets) != 4 {
		t.Fatalf("facets = %#v", facets)
	}
	if facets[0] != (DeveloperFacet{Type: "language", Value: "TypeScript", Weight: 100}) ||
		facets[1] != (DeveloperFacet{Type: "org", Value: "huggingface", Weight: 1}) ||
		facets[2] != (DeveloperFacet{Type: "org", Value: "pytorch", Weight: 1}) ||
		facets[3] != (DeveloperFacet{Type: "repo", Value: "langgenius/dify", Weight: 60000}) {
		t.Fatalf("facets = %#v", facets)
	}
}

func TestExtractRepoGraphMakesOwnerWinOverContribution(t *testing.T) {
	scan := ScanResult{
		TopRepos:    []TopRepo{{Name: "Cool", NameWithOwner: stringPointer("Alice/Cool"), Stars: 1200, Language: stringPointer("Go")}},
		ImpactRepos: []ImpactRepo{{Repo: "alice/cool", Stars: 1200, Commits: 5, PRs: 2}, {Repo: "langgenius/dify", Stars: 60000, Commits: 12, PRs: 3}},
	}
	graph := ExtractRepoGraph(scan)
	if len(graph.Nodes) != 2 || len(graph.Links) != 2 {
		t.Fatalf("graph = %#v", graph)
	}
	if graph.Links[0].Relation != "owner" || graph.Links[0].Key != "alice/cool" || graph.Links[1].Relation != "contributor" || graph.Links[1].Key != "langgenius/dify" {
		t.Fatalf("links = %#v", graph.Links)
	}
}

func TestRepoFacetsRankByContributionBeforeStars(t *testing.T) {
	impact := []ImpactRepo{}
	for i := 0; i < 25; i++ {
		impact = append(impact, ImpactRepo{Repo: fmt.Sprintf("famous/r%d", i), Stars: 50000 + float64(i), Commits: 2})
	}
	impact = append(impact, ImpactRepo{Repo: "org/maintained", Stars: 1200, Commits: 387, PRs: 89})
	facets := extractRepoFacets(impact)
	if len(facets) != 20 {
		t.Fatalf("len(facets) = %d, want 20", len(facets))
	}
	if facets[0] != (DeveloperFacet{Type: "repo", Value: "org/maintained", Weight: 1200}) {
		t.Fatalf("facets[0] = %#v", facets[0])
	}
	graph := contributorGraph(impact)
	if len(graph.Links) != 20 || graph.Links[0].Key != "org/maintained" {
		t.Fatalf("graph links = %#v", graph.Links)
	}
	for i, link := range graph.Links {
		if link.Key != strings.ToLower(facets[i].Value) {
			t.Fatalf("graph link %d = %s, facet = %s", i, link.Key, facets[i].Value)
		}
	}
}
