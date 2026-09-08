package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CFFeedStore uses the binding worker's business capabilities through ordinary
// HTTP. No SQL, SDK, user supplied host, or platform management API is involved.
type CFFeedStore struct {
	endpoint    string
	secret      string
	client      *http.Client
	writerEpoch int64
}

func NewCFFeedStore(endpoint, secret string, client *http.Client) (*CFFeedStore, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || len(secret) < 32 {
		return nil, fmt.Errorf("valid bridge endpoint and secret (>=32 bytes) are required")
	}
	if parsed.Scheme == "http" && parsed.Hostname() != "feed-bindings.internal" && parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1" {
		return nil, fmt.Errorf("bridge HTTP requires private container handler or loopback")
	}
	if client == nil {
		client = &http.Client{Timeout: 4 * time.Second}
	}
	clone := *client
	clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &CFFeedStore{endpoint: strings.TrimRight(endpoint, "/"), secret: secret, client: &clone, writerEpoch: 1}, nil
}
func (s *CFFeedStore) call(ctx context.Context, op string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	if len(body) > 2<<20 {
		return fmt.Errorf("bridge request too large")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint+"/internal/feed/v1/"+op, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+s.secret)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Feed-Contract", FeedBridgeVersion)
	response, err := s.client.Do(request)
	if err != nil {
		return fmt.Errorf("feed bridge %s unavailable", op)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(data) > 4<<20 {
		return fmt.Errorf("invalid bridge response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		switch failure.Error {
		case "proposal_id_conflict":
			return ErrFeedProposalConflict
		case "job_identity_conflict":
			return ErrFeedJobConflict
		case "job_lease_lost":
			return ErrFeedJobLease
		case "writer_epoch_changed":
			return ErrFeedWriterEpoch
		case "profile_version_changed":
			return ErrFeedProfileChanged
		case "event_id_conflict":
			return ErrFeedEventConflict
		case "deletion_not_found":
			return ErrFeedDeletionNotFound
		case "taxonomy_version_changed":
			return ErrFeedTaxonomyChanged
		case "project_not_found":
			return ErrFeedProjectNotFound
		case "session_not_found":
			return ErrFeedSessionNotFound
		}
		return fmt.Errorf("feed bridge %s returned %d", op, response.StatusCode)
	}
	if output == nil {
		return nil
	}
	if err := json.Unmarshal(data, output); err != nil {
		return fmt.Errorf("decode feed bridge %s: %w", op, err)
	}
	return nil
}
func (s *CFFeedStore) Ping(ctx context.Context) error {
	var out FeedBridgeHealthResponse
	if err := s.call(ctx, "health", struct{}{}, &out); err != nil {
		return err
	}
	if !out.Ready || out.ContractVersion != FeedBridgeVersion || out.WriterEpoch != s.writerEpoch || !out.WritesEnabled {
		return errors.New("feed bridge not ready or incompatible")
	}
	return nil
}
func (s *CFFeedStore) Close() error { return nil }
func (s *CFFeedStore) ListFeedTags(ctx context.Context) ([]FeedTag, int64, error) {
	var out FeedBridgeTagsResponse
	err := s.call(ctx, "taxonomy.list", struct{}{}, &out)
	return out.Tags, out.TaxonomyVersion, err
}
func (s *CFFeedStore) ActiveTaxonomyVersion(ctx context.Context) (int64, error) {
	_, v, e := s.ListFeedTags(ctx)
	return v, e
}
func (s *CFFeedStore) user(ctx context.Context, op string, in any) (*FeedUser, error) {
	var out FeedBridgeUserResponse
	err := s.call(ctx, op, in, &out)
	if err != nil || out.User == nil {
		return nil, err
	}
	u := out.User.user()
	return &u, nil
}
func (s *CFFeedStore) EnsureFeedUser(ctx context.Context, u OAuthSession) (*FeedUser, error) {
	return s.user(ctx, "users.ensure", FeedBridgeEnsureUserRequest{FeedMutationFence: s.fence(ctx, 0), GitHubID: u.GitHubID, Login: u.Login, AvatarURL: u.AvatarURL})
}
func (s *CFFeedStore) GetFeedUser(ctx context.Context, id int64) (*FeedUser, error) {
	return s.user(ctx, "users.get", FeedBridgeUserRequest{id})
}
func (s *CFFeedStore) ReplaceExplicitFeedPreferences(ctx context.Context, id, version int64, p []FeedPreference) (*FeedUser, error) {
	return s.user(ctx, "preferences.replace", FeedBridgePreferencesRequest{FeedMutationFence: s.fence(ctx, 0), GitHubID: id, TaxonomyVersion: version, Preferences: p})
}
func (s *CFFeedStore) LoadFeedCandidates(ctx context.Context, u FeedUser, limit int) ([]FeedCandidate, map[string]int, error) {
	var out FeedBridgeCandidatesResponse
	if limit < 1 || limit > 240 {
		return nil, nil, errors.New("invalid candidate limit")
	}
	err := s.call(ctx, "candidates.load", FeedBridgeCandidatesRequest{u.GitHubID, limit}, &out)
	if err != nil {
		return nil, nil, err
	}
	if len(out.Candidates) > 240 {
		return nil, nil, errors.New("bridge exceeded candidate bound")
	}
	c := make([]FeedCandidate, 0, len(out.Candidates))
	for _, d := range out.Candidates {
		c = append(c, d.candidate())
	}
	return c, out.Counts, nil
}
func (s *CFFeedStore) AvailableFeedRepoKeys(ctx context.Context, id int64, keys []string) (map[string]bool, error) {
	var out FeedBridgeAvailableResponse
	if len(keys) > 240 {
		return nil, errors.New("too many keys")
	}
	err := s.call(ctx, "projects.available", FeedBridgeAvailableRequest{id, keys}, &out)
	return out.Available, err
}
func (s *CFFeedStore) SaveFeedRequest(ctx context.Context, r FeedRequestRecord) error {
	in := FeedBridgeSaveRequest{FeedMutationFence: s.fence(ctx, r.User.ProfileVersion), ID: r.ID, User: feedUserDTO(r.User), Seed: r.Seed, CandidateCounts: r.CandidateCounts, Degraded: r.Degraded, DurationMS: r.Duration.Milliseconds(), Items: []FeedRankedItemDTO{}}
	for _, i := range r.Items {
		in.Items = append(in.Items, feedRankedItemDTO(i))
	}
	encoded, err := json.Marshal(in)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(encoded)
	in.PayloadHash = fmt.Sprintf("%x", hash)
	return s.call(ctx, "requests.save", in, nil)
}
func (s *CFFeedStore) SetFeedProjectState(ctx context.Context, id int64, key string, p FeedStatePatch, now time.Time) (FeedProjectState, error) {
	var out FeedProjectState
	err := s.call(ctx, "state.set", FeedBridgeStateRequest{FeedMutationFence: s.fence(ctx, 0), GitHubID: id, RepoKey: key, RequestID: p.RequestID, Saved: p.Saved, NotInterested: p.NotInterested, Now: now}, &out)
	return out, err
}
func (s *CFFeedStore) AppendFeedEvents(ctx context.Context, id int64, events []AcceptedFeedEvent) (FeedEventAppendResult, error) {
	in := FeedBridgeEventsRequest{FeedMutationFence: s.fence(ctx, 0), GitHubID: id, Events: []FeedAcceptedEventDTO{}}
	for _, e := range events {
		m := FeedEventMetadataDTO{}
		encoded, err := json.Marshal(e.Metadata)
		if err != nil {
			return FeedEventAppendResult{}, err
		}
		decoder := json.NewDecoder(bytes.NewReader(encoded))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&m); err != nil {
			return FeedEventAppendResult{}, err
		}
		in.Events = append(in.Events, FeedAcceptedEventDTO{e.Input, e.RequestID, m})
	}
	var out FeedEventAppendResult
	err := s.call(ctx, "events.append", in, &out)
	return out, err
}
func (s *CFFeedStore) DeleteFeedProfile(ctx context.Context, id int64, now time.Time) (string, error) {
	var out FeedBridgeDeleteResponse
	err := s.call(ctx, "profile.delete", FeedBridgeDeleteRequest{FeedMutationFence: s.fence(ctx, 0), GitHubID: id, Now: now}, &out)
	return out.DeletionID, err
}
func (s *CFFeedStore) GetFeedDeletion(ctx context.Context, id int64, deletionID string) (FeedBridgeDeleteResponse, error) {
	var out FeedBridgeDeleteResponse
	err := s.call(ctx, "profile.deletion.get", FeedBridgeDeletionRequest{id, deletionID}, &out)
	return out, err
}
func (s *CFFeedStore) PutFeedSession(ctx context.Context, session FeedSession, _ time.Duration) error {
	return s.call(ctx, "sessions.put", FeedBridgePutSessionRequest{FeedMutationFence: s.fence(ctx, session.ProfileVersion), Session: feedSessionDTO(session)}, nil)
}
func (s *CFFeedStore) GetFeedSession(ctx context.Context, id string) (*FeedSession, error) {
	return nil, errors.New("actor-scoped session lookup required")
}
func (s *CFFeedStore) GetFeedSessionForUser(ctx context.Context, githubID int64, id string) (*FeedSession, error) {
	var out FeedBridgeSessionResponse
	if err := s.call(ctx, "sessions.get", FeedBridgeSessionRequest{GitHubID: githubID, ID: id}, &out); err != nil {
		return nil, err
	}
	session := out.Session.session()
	return &session, nil
}
func (s *CFFeedStore) DeleteFeedSession(context.Context, string) error {
	return errors.New("actor-scoped session deletion required")
}
func (s *CFFeedStore) DeleteFeedSessionForUser(ctx context.Context, id int64, sessionID string) error {
	return s.call(ctx, "sessions.delete", FeedBridgeSessionRequest{FeedMutationFence: s.fence(ctx, 0), GitHubID: id, ID: sessionID}, nil)
}

// SetWriterEpoch binds this process to one migration control epoch.
func (s *CFFeedStore) SetWriterEpoch(epoch int64) error {
	if epoch < 1 {
		return errors.New("positive writer epoch required")
	}
	s.writerEpoch = epoch
	return nil
}
func (s *CFFeedStore) fence(ctx context.Context, fallback int64) FeedMutationFence {
	version, _ := ctx.Value(feedProfileVersionKey{}).(int64)
	if version == 0 {
		version = fallback
	}
	return FeedMutationFence{WriterEpoch: s.writerEpoch, ExpectedProfileVersion: version}
}

var _ FeedServingStore = (*CFFeedStore)(nil)
var _ FeedSessionStore = (*CFFeedStore)(nil)
var _ FeedDeletionStore = (*CFFeedStore)(nil)
