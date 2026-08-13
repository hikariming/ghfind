package backend

import (
	"context"
	"sync"
	"testing"
	"time"
)

type fakeCampaignRevisionStore struct {
	mu       sync.Mutex
	revision *int64
	err      error
	calls    int
}

func (s *fakeCampaignRevisionStore) GetCampaignLeaderboardRevision(context.Context, string) (*int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.revision == nil {
		return nil, s.err
	}
	value := *s.revision
	return &value, s.err
}

func (s *fakeCampaignRevisionStore) setRevision(value int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revision = &value
}

func TestCampaignSSEHubSharesRevisionPollingAndCleansUp(t *testing.T) {
	initial := int64(3)
	store := &fakeCampaignRevisionStore{revision: &initial}
	hub := newCampaignSSEHub(store)
	hub.pollInterval = 10 * time.Millisecond
	first, firstUnsubscribe, err := hub.subscribe(context.Background(), "advx")
	if err != nil {
		t.Fatal(err)
	}
	second, secondUnsubscribe, err := hub.subscribe(context.Background(), "advx")
	if err != nil {
		t.Fatal(err)
	}
	store.setRevision(4)
	for index, listener := range []<-chan int64{first, second} {
		select {
		case revision := <-listener:
			if revision != 4 {
				t.Fatalf("listener %d revision=%d", index, revision)
			}
		case <-time.After(time.Second):
			t.Fatalf("listener %d did not receive revision", index)
		}
	}
	firstUnsubscribe()
	secondUnsubscribe()
	time.Sleep(20 * time.Millisecond)
	hub.mu.Lock()
	remaining := len(hub.channels)
	hub.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("remaining campaign channels=%d", remaining)
	}
}

func TestCampaignSSEHubSubscribesWithoutStoredRevision(t *testing.T) {
	// The revision key expires 7 days after the last campaign join; a missing
	// key must not 503 the stream — it starts at 0 and picks up the next bump.
	store := &fakeCampaignRevisionStore{}
	hub := newCampaignSSEHub(store)
	hub.pollInterval = 10 * time.Millisecond
	listener, unsubscribe, err := hub.subscribe(context.Background(), "advx")
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()
	store.setRevision(1)
	select {
	case revision := <-listener:
		if revision != 1 {
			t.Fatalf("revision=%d", revision)
		}
	case <-time.After(time.Second):
		t.Fatal("listener did not receive the first bump")
	}
}

func TestCampaignSSEHubEnforcesPerCampaignCapacity(t *testing.T) {
	initial := int64(1)
	hub := newCampaignSSEHub(&fakeCampaignRevisionStore{revision: &initial})
	unsubscribers := make([]func(), 0, maxCampaignStreams)
	for index := 0; index < maxCampaignStreams; index++ {
		_, unsubscribe, err := hub.subscribe(context.Background(), "advx")
		if err != nil {
			t.Fatalf("subscribe %d: %v", index, err)
		}
		unsubscribers = append(unsubscribers, unsubscribe)
	}
	if _, _, err := hub.subscribe(context.Background(), "advx"); err != errCampaignStreamCap {
		t.Fatalf("capacity error=%v", err)
	}
	for _, unsubscribe := range unsubscribers {
		unsubscribe()
	}
}
