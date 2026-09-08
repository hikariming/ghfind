package backend

import (
	"context"
	"errors"
	"net/http"
	"time"
)

type feedProfileVersionKey struct{}

func withFeedProfileVersion(ctx context.Context, version int64) context.Context {
	return context.WithValue(ctx, feedProfileVersionKey{}, version)
}

type ActorFeedSessionStore interface {
	GetFeedSessionForUser(context.Context, int64, string) (*FeedSession, error)
	DeleteFeedSessionForUser(context.Context, int64, string) error
}

// NewStandaloneFeedHandler reuses domain handlers without registering any legacy
// routes or creating OAuth, assessment, scan, RabbitMQ, or Redis dependencies.
// authenticate must verify a signed request; it may never read naked identity headers.
func NewStandaloneFeedHandler(mode FeedMode, signingSecret string, store FeedServingStore, sessions FeedSessionStore, authenticate func(*http.Request, time.Time) *OAuthSession) (http.Handler, error) {
	if (mode != FeedModeOff && mode != FeedModeBaseline) || store == nil || sessions == nil || authenticate == nil {
		return nil, errors.New("standalone Feed requires explicit store, sessions, authentication and baseline/off mode")
	}
	if _, ok := store.(FeedSnapshotCatalogStore); !ok {
		return nil, errors.New("standalone Feed requires snapshot identity validation")
	}
	signer, err := NewFeedSigner(signingSecret)
	if err != nil {
		return nil, err
	}
	s := &APIServer{config: Config{FeedMode: mode, FeedSigningSecret: signingSecret}, feed: store, feedSessions: sessions, feedSigner: signer, metrics: NewBackendMetrics(), clock: time.Now, feedAuthenticate: authenticate, portableFeed: true}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/feed/tags", withFeedRequestTimeout(s.feedTags))
	mux.HandleFunc("POST /api/feed/tags/proposals", withFeedRequestTimeout(s.proposeFeedTag))
	mux.HandleFunc("GET /api/feed/preferences", withFeedRequestTimeout(s.feedPreferences))
	mux.HandleFunc("PUT /api/feed/preferences", withFeedRequestTimeout(s.feedPreferences))
	mux.HandleFunc("GET /api/feed/projects", withFeedRequestTimeout(s.feedProjects))
	mux.HandleFunc("PUT /api/feed/projects/{owner}/{repo}/state", withFeedRequestTimeout(s.feedProjectState))
	mux.HandleFunc("PATCH /api/feed/projects/{owner}/{repo}/state", withFeedRequestTimeout(s.feedProjectState))
	mux.HandleFunc("POST /api/feed/events", withFeedRequestTimeout(s.feedEvents))
	mux.HandleFunc("DELETE /api/feed/profile", withFeedRequestTimeout(s.deleteFeedProfile))
	mux.HandleFunc("GET /api/feed/profile/deletions/{deletionId}", withFeedRequestTimeout(s.feedDeletionStatus))
	return mux, nil
}

type feedVerifiedIdentityKey struct{}
type feedVerifiedIdentity struct{ session *OAuthSession }

func (s *APIServer) feedOAuth(request *http.Request, now time.Time) *OAuthSession {
	if s.feedAuthenticate != nil {
		if cached, ok := request.Context().Value(feedVerifiedIdentityKey{}).(feedVerifiedIdentity); ok {
			return cached.session
		}
		session := s.feedAuthenticate(request, now)
		*request = *request.WithContext(context.WithValue(request.Context(), feedVerifiedIdentityKey{}, feedVerifiedIdentity{session}))
		return session
	}
	return s.sessionFromRequest(request, now)
}
func (s *APIServer) feedDeletionStatus(w http.ResponseWriter, r *http.Request) {
	user := s.feedOAuth(r, s.clock().UTC())
	if user == nil {
		writeJSON(w, 401, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return
	}
	store, ok := s.feed.(FeedDeletionStore)
	if !ok {
		writeJSON(w, 503, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	state, err := store.GetFeedDeletion(r.Context(), user.GitHubID, r.PathValue("deletionId"))
	if err != nil {
		if !errors.Is(err, ErrFeedDeletionNotFound) {
			writeJSON(w, 503, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
			return
		}
		writeJSON(w, 404, map[string]string{"error": "deletion_not_found"}, noStoreHeaders())
		return
	}
	writeJSON(w, 200, state, noStoreHeaders())
}

var ErrFeedDeletionNotFound = errors.New("feed deletion not found")
var ErrFeedEventConflict = errors.New("feed event identity conflict")

func writeFeedMutationError(w http.ResponseWriter, err error) bool {
	code := ""
	switch {
	case errors.Is(err, ErrFeedWriterEpoch):
		code = "writer_epoch_changed"
	case errors.Is(err, ErrFeedProfileChanged):
		code = "profile_version_changed"
	case errors.Is(err, ErrFeedTaxonomyChanged):
		code = "taxonomy_version_changed"
	case errors.Is(err, ErrFeedEventConflict):
		code = "event_id_conflict"
	}
	if code == "" {
		return false
	}
	writeJSON(w, http.StatusConflict, map[string]string{"error": code}, noStoreHeaders())
	return true
}
