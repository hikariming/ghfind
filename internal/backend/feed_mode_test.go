package backend

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestFeedConfigurationIsOptionalAndFailClosedWhenEnabled(t *testing.T) {
	config := Config{FeedMode: FeedModeOff}
	if err := config.validateFeed(); err != nil {
		t.Fatalf("off: %v", err)
	}
	config.FeedMode = FeedModeBaseline
	if err := config.validateFeed(); err == nil || !strings.Contains(err.Error(), "FEED_DATABASE_URL") {
		t.Fatalf("missing DB err=%v", err)
	}
	config.FeedDatabaseURL = "postgres://feed"
	if err := config.validateFeed(); err == nil || !strings.Contains(err.Error(), "FEED_SIGNING_SECRET") {
		t.Fatalf("missing signer err=%v", err)
	}
	config.FeedSigningSecret = strings.Repeat("x", 32)
	if err := config.validateFeed(); err != nil {
		t.Fatalf("baseline config: %v", err)
	}
	config.FeedGorseLiveBPS = 500
	if err := config.validateFeed(); err == nil || !strings.Contains(err.Error(), "FEED_GORSE_LIVE_BPS") {
		t.Fatalf("live Gorse should require canary mode: %v", err)
	}
	config.FeedGorseLiveBPS = 0
	config.FeedMode = FeedModeGorseShadow
	if err := config.validateFeed(); err == nil || !strings.Contains(err.Error(), "GORSE_BASE_URL") {
		t.Fatalf("missing gorse err=%v", err)
	}
	config.GorseBaseURL = "http://gorse:8088"
	if err := config.validateFeed(); err == nil || !strings.Contains(err.Error(), "GORSE_SERVER_API_KEY") {
		t.Fatalf("missing gorse server key err=%v", err)
	}
	config.GorseServerAPIKey = "server-key"
	if err := config.validateFeed(); err == nil || !strings.Contains(err.Error(), "GORSE_ADMIN_API_KEY") {
		t.Fatalf("missing gorse admin key err=%v", err)
	}
	config.GorseAdminAPIKey = "admin-key"
	if err := config.validateFeed(); err != nil {
		t.Fatalf("gorse shadow config: %v", err)
	}
}

func TestFeedShadowOutcomeWindowIsShortAndBounded(t *testing.T) {
	if got := boundedDurationValue("1h", defaultFeedShadowOutcomeWindow, minFeedShadowOutcomeWindow, maxFeedShadowOutcomeWindow); got != time.Hour {
		t.Fatalf("accelerated window=%s", got)
	}
	if got := boundedDurationValue("30m", defaultFeedShadowOutcomeWindow, minFeedShadowOutcomeWindow, maxFeedShadowOutcomeWindow); got != defaultFeedShadowOutcomeWindow {
		t.Fatalf("too-short window should use safe default, got=%s", got)
	}
	if got := boundedDurationValue("720h", defaultFeedShadowOutcomeWindow, minFeedShadowOutcomeWindow, maxFeedShadowOutcomeWindow); got != maxFeedShadowOutcomeWindow {
		t.Fatalf("long window should cap at seven days, got=%s", got)
	}
}

func TestOpenPostgresFeedStoreDoesNotRequireReachableDatabase(t *testing.T) {
	store, err := OpenPostgresFeedStore(Config{
		FeedMode:        FeedModeBaseline,
		FeedDatabaseURL: "postgres://feed:feed@127.0.0.1:1/feed?sslmode=disable&connect_timeout=1",
	})
	if err != nil {
		t.Fatalf("opening an optional lazy Feed pool must not dial PostgreSQL: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := store.Ping(ctx); err == nil {
		t.Fatal("the dedicated Feed readiness check must fail for an unreachable database")
	}
}
