package backend

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestEstimatedContributionLanguagesIncludesPersonalOrganizationAndExternalWorkWithoutScoringSideEffects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/repos/dev/low-star-go/languages":
			_, _ = writer.Write([]byte(`{"Go":100}`))
		case "/repos/org/typescript-service/languages":
			_, _ = writer.Write([]byte(`{"TypeScript":100}`))
		case "/repos/other/rust-library/languages":
			_, _ = writer.Write([]byte(`{"Rust":100}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewGitHubClient("test-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	metrics := RawMetrics{Username: "dev", Followers: 42, MergedPRCount: 10}
	before := Score(metrics)
	estimate := client.collectEstimatedContributionLanguages(context.Background(), []ContribRepoAgg{
		{Repo: "dev/low-star-go", OwnerLogin: "dev", Commits: 100, Stars: 1},
		{Repo: "org/typescript-service", OwnerLogin: "org", Commits: 1, PRs: 2, Stars: 1},
		{Repo: "other/rust-library", OwnerLogin: "other", PRs: 1, Stars: 1},
		{Repo: "private/hidden", OwnerLogin: "private", Commits: 1000, IsPrivate: true},
		{Repo: "fork/ignored", OwnerLogin: "fork", Commits: 1000, IsFork: true},
	})
	if estimate == nil {
		t.Fatal("estimate is nil")
	}
	if estimate.CandidateRepoCount != 3 || estimate.SelectedRepoCount != 3 || estimate.SampledRepoCount != 3 {
		t.Fatalf("coverage=%#v", estimate)
	}
	if got, want := estimate.Languages, []EstimatedContributionLanguage{
		{Name: "Go", Pct: 54},
		{Name: "TypeScript", Pct: 27},
		{Name: "Rust", Pct: 19},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("languages=%#v want=%#v", got, want)
	}

	// The estimate only lives in SignatureWork. Score receives the exact same
	// RawMetrics, regardless of personal, organization, or external sources.
	scan := ScanResult{Metrics: metrics, SignatureWork: SignatureWork{EstimatedContributionLanguages: estimate}}
	if after := Score(scan.Metrics); !reflect.DeepEqual(after, before) {
		t.Fatalf("contribution language estimate changed score: before=%#v after=%#v", before, after)
	}
}

func TestEstimatedContributionLanguagesBoundsRepositoryReadsToTopFifty(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"Go":1}`))
	}))
	defer server.Close()

	contributions := make([]ContribRepoAgg, 0, maxContributionLanguageRepos+1)
	for index := 0; index <= maxContributionLanguageRepos; index++ {
		contributions = append(contributions, ContribRepoAgg{
			Repo:       fmt.Sprintf("org/repo-%02d", index),
			Commits:    float64(maxContributionLanguageRepos + 1 - index),
			OwnerLogin: "org",
		})
	}
	client := NewGitHubClient("test-token").withBaseURL(server.URL).withHTTPClient(server.Client())
	estimate := client.collectEstimatedContributionLanguages(context.Background(), contributions)
	if estimate == nil {
		t.Fatal("estimate is nil")
	}
	if estimate.CandidateRepoCount != maxContributionLanguageRepos+1 || estimate.SelectedRepoCount != maxContributionLanguageRepos || estimate.SampledRepoCount != maxContributionLanguageRepos {
		t.Fatalf("coverage=%#v", estimate)
	}
	if requests != maxContributionLanguageRepos {
		t.Fatalf("language requests=%d want=%d", requests, maxContributionLanguageRepos)
	}
}
