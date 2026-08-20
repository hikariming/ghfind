package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

var ErrFeedSessionNotFound = errors.New("Feed session not found")

type FeedSessionStore interface {
	PutFeedSession(context.Context, FeedSession, time.Duration) error
	GetFeedSession(context.Context, string) (*FeedSession, error)
	DeleteFeedSession(context.Context, string) error
}

func feedSessionKey(id string) string { return "feed:session:v1:" + id }

func (s *UpstashStatusStore) PutFeedSession(ctx context.Context, session FeedSession, ttl time.Duration) error {
	encoded, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("encode Feed session: %w", err)
	}
	seconds := int64(ttl.Seconds())
	if seconds < 1 {
		seconds = int64(FeedSessionTTL.Seconds())
	}
	_, _, err = s.command(ctx, "SET", feedSessionKey(session.ID), string(encoded), "EX", seconds)
	if err != nil {
		return fmt.Errorf("save Feed session: %w", err)
	}
	return nil
}

func (s *UpstashStatusStore) GetFeedSession(ctx context.Context, id string) (*FeedSession, error) {
	result, found, err := s.command(ctx, "GET", feedSessionKey(id))
	if err != nil {
		return nil, fmt.Errorf("read Feed session: %w", err)
	}
	if !found || string(result) == "null" {
		return nil, ErrFeedSessionNotFound
	}
	var encoded string
	if err := json.Unmarshal(result, &encoded); err != nil {
		return nil, fmt.Errorf("decode Feed session envelope: %w", err)
	}
	var session FeedSession
	if err := json.Unmarshal([]byte(encoded), &session); err != nil {
		return nil, fmt.Errorf("decode Feed session: %w", err)
	}
	return &session, nil
}

func (s *UpstashStatusStore) DeleteFeedSession(ctx context.Context, id string) error {
	_, _, err := s.command(ctx, "DEL", feedSessionKey(id))
	return err
}

// MemoryFeedSessionStore keeps Feed API contract tests independent from
// Upstash. Production always injects Upstash and therefore gets the required
// cross-instance cursor behavior.
type MemoryFeedSessionStore struct {
	mu       sync.Mutex
	sessions map[string]FeedSession
	now      func() time.Time
}

func NewMemoryFeedSessionStore() *MemoryFeedSessionStore {
	return &MemoryFeedSessionStore{sessions: map[string]FeedSession{}, now: time.Now}
}

func (s *MemoryFeedSessionStore) PutFeedSession(_ context.Context, session FeedSession, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if session.ExpiresAt.IsZero() {
		session.ExpiresAt = s.now().UTC().Add(ttl)
	}
	s.sessions[session.ID] = session
	return nil
}

func (s *MemoryFeedSessionStore) GetFeedSession(_ context.Context, id string) (*FeedSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[id]
	if !ok || !session.ExpiresAt.After(s.now().UTC()) {
		delete(s.sessions, id)
		return nil, ErrFeedSessionNotFound
	}
	copy := session
	return &copy, nil
}

func (s *MemoryFeedSessionStore) DeleteFeedSession(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
	return nil
}

var _ FeedSessionStore = (*UpstashStatusStore)(nil)
var _ FeedSessionStore = (*MemoryFeedSessionStore)(nil)
