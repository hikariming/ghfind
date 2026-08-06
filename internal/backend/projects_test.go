package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProjectsPresentationUsesCanonicalGraphRows(t *testing.T) {
	store := openProfileAPITestStore(t)
	insertProfileAPITestScore(t, store, "octocat", 88.2)
	insertProfileAPITestScore(t, store, "teammate", 81.4)
	for _, statement := range []string{
		`INSERT INTO repos (repo_key, name_with_owner, owner_login, name, description, stars, forks, language, topics)
		 VALUES ('octocat/widget', 'octocat/widget', 'octocat', 'widget', 'A useful widget', 120, 4, 'Go', '["cli"]')`,
		`INSERT INTO repos (repo_key, name_with_owner, owner_login, name, description, stars, forks, language, topics)
		 VALUES ('shared/tool', 'shared/tool', 'shared', 'tool', NULL, 80, 1, 'Go', '[]')`,
		`INSERT INTO repo_developers (repo_key, username) VALUES ('octocat/widget', 'octocat')`,
		`INSERT INTO repo_developers (repo_key, username) VALUES ('octocat/widget', 'teammate')`,
		`INSERT INTO repo_developers (repo_key, username) VALUES ('shared/tool', 'octocat')`,
		`INSERT INTO repo_developers (repo_key, username) VALUES ('shared/tool', 'teammate')`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	projects, err := store.GetProjects(context.Background(), ProjectListOptions{Sort: "quality", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 || projects[0].ContributorCount != 2 || len(projects[0].TopContributors) != 2 {
		t.Fatalf("projects=%#v", projects)
	}
	overview, err := store.GetProjectOverview(context.Background(), "octocat/widget")
	if err != nil {
		t.Fatal(err)
	}
	if overview == nil || overview.Owner == nil || overview.Summary.Count != 2 || overview.Repo.Topics[0] != "cli" {
		t.Fatalf("overview=%#v", overview)
	}
	related, err := store.GetRelatedProjects(context.Background(), "octocat/widget", 6)
	if err != nil {
		t.Fatal(err)
	}
	if len(related) != 1 || related[0].Project.Repo.RepoKey != "shared/tool" || related[0].SharedContributorCount != 2 {
		t.Fatalf("related=%#v", related)
	}

	server := NewAPIServer(Config{}, store, &fakeStatusStore{}, &fakePublisher{})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/projects?sort=quality&limit=10", nil))
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != projectsCacheControl {
		t.Fatalf("status=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
}
