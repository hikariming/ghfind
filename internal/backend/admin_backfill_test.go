package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type adminBackfillFixtureStore struct {
	fakeScoreStore
	usernames []string
	calls     int
}

func (s *adminBackfillFixtureStore) ListSnapshotUsernames(context.Context, int, int) ([]string, error) {
	return s.usernames, nil
}

func (s *adminBackfillFixtureStore) RebuildProfileIndexes(context.Context, string) (int, int, int, bool, error) {
	s.calls++
	return 2, 3, 4, true, nil
}

func TestAdminIndexBackfillRequiresSecretAndDryRunDoesNotWrite(t *testing.T) {
	store := &adminBackfillFixtureStore{usernames: []string{"octocat"}}
	server := NewAPIServer(Config{AdminSecret: "admin-secret"}, store, &fakeStatusStore{}, &fakePublisher{})
	unauthorized := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/api/admin/backfill-facets", nil))
	if unauthorized.Code != http.StatusForbidden {
		t.Fatalf("unauthorized status=%d", unauthorized.Code)
	}
	dryRequest := httptest.NewRequest(http.MethodPost, "/api/admin/backfill-facets?dry=1", nil)
	dryRequest.Header.Set("x-admin-secret", "admin-secret")
	dry := httptest.NewRecorder()
	server.Handler().ServeHTTP(dry, dryRequest)
	if dry.Code != http.StatusOK || store.calls != 0 || !strings.Contains(dry.Body.String(), `"dryRun":true`) {
		t.Fatalf("dry status=%d calls=%d body=%s", dry.Code, store.calls, dry.Body.String())
	}
	applyRequest := httptest.NewRequest(http.MethodPost, "/api/admin/backfill-repos", nil)
	applyRequest.Header.Set("x-admin-secret", "admin-secret")
	apply := httptest.NewRecorder()
	server.Handler().ServeHTTP(apply, applyRequest)
	if apply.Code != http.StatusOK || store.calls != 1 || !strings.Contains(apply.Body.String(), `"repoCount":3`) {
		t.Fatalf("apply status=%d calls=%d body=%s", apply.Code, store.calls, apply.Body.String())
	}
}

func TestAdminScoreBackfillIsExplicitlyPaused(t *testing.T) {
	server := NewAPIServer(Config{AdminSecret: "admin-secret"}, fakeScoreStore{}, &fakeStatusStore{}, &fakePublisher{})
	request := httptest.NewRequest(http.MethodPost, "/api/admin/backfill-scores", nil)
	request.Header.Set("x-admin-secret", "admin-secret")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"backfill_paused"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
