package backend

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeFeedCleanupStore struct {
	steps, releases, failures int
	completeAt                int
	failAt                    int
}

func (s *fakeFeedCleanupStore) ClaimFeedCleanup(context.Context, FeedCleanupClaim) (FeedCleanupLease, error) {
	return FeedCleanupLease{Status: "leased", DeletionID: "deletion-1", ProfileFloor: 5, Phase: "archive"}, nil
}
func (s *fakeFeedCleanupStore) StepFeedCleanup(context.Context, FeedCleanupCommand) (FeedCleanupProgress, error) {
	s.steps++
	if s.steps == s.failAt {
		return FeedCleanupProgress{}, errors.New("archive outage")
	}
	if s.steps == s.completeAt {
		return FeedCleanupProgress{Status: "completed", Phase: "completed"}, nil
	}
	return FeedCleanupProgress{Status: "running", Phase: "archive", Processed: 100}, nil
}
func (s *fakeFeedCleanupStore) FailFeedCleanup(context.Context, FeedCleanupCommand) error {
	s.failures++
	return nil
}
func (s *fakeFeedCleanupStore) ReleaseFeedCleanup(context.Context, FeedCleanupCommand) error {
	s.releases++
	return nil
}
func TestFeedCleanupYieldsWithoutFailureAtBound(t *testing.T) {
	store := &fakeFeedCleanupStore{}
	executor, _ := NewFeedCleanupExecutor(store, 1, "cleanup-secret-test-0123456789abcdef")
	result, err := executor.Execute(context.Background())
	if err != nil || result.Status != "queued" || result.Steps != 8 || result.Processed != 800 || store.releases != 1 || store.failures != 0 {
		t.Fatalf("result=%+v store=%+v err=%v", result, store, err)
	}
}
func TestFeedCleanupCompletionAndFailureAreDurable(t *testing.T) {
	for _, fails := range []bool{false, true} {
		store := &fakeFeedCleanupStore{completeAt: 3}
		if fails {
			store.failAt = 2
		}
		executor, _ := NewFeedCleanupExecutor(store, 1, "cleanup-secret-test-0123456789abcdef")
		result, err := executor.Execute(context.Background())
		if fails {
			if err == nil || store.failures != 1 || store.releases != 0 {
				t.Fatal("failure not persisted", store, err)
			}
		} else if err != nil || result.Status != "completed" || store.steps != 3 || store.releases != 0 {
			t.Fatal("completion incorrect", result, store, err)
		}
	}
}

type interruptedCleanupStore struct{ fakeFeedCleanupStore }

func (s *interruptedCleanupStore) StepFeedCleanup(ctx context.Context, _ FeedCleanupCommand) (FeedCleanupProgress, error) {
	<-ctx.Done()
	return FeedCleanupProgress{}, ctx.Err()
}
func (s *interruptedCleanupStore) ReleaseFeedCleanup(ctx context.Context, c FeedCleanupCommand) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return s.fakeFeedCleanupStore.ReleaseFeedCleanup(ctx, c)
}
func TestFeedCleanupDeadlineYieldsWithLiveReleaseContext(t *testing.T) {
	store := &interruptedCleanupStore{}
	executor, _ := NewFeedCleanupExecutor(store, 1, "cleanup-secret-test-0123456789abcdef")
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	result, err := executor.Execute(ctx)
	if err != nil || result.Status != "queued" || store.releases != 1 || store.failures != 0 {
		t.Fatalf("deadline result%+v release%d failure%d err%v", result, store.releases, store.failures, err)
	}
}
