package backend

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/hikariming/ghfind/internal/feedmigration"
)

func TestPortablePostgresSchemaCompatibility(t *testing.T) {
	dsn := os.Getenv("FEED_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("FEED_REQUIRE_POSTGRES_TESTS") == "1" {
			t.Fatal("real PostgreSQL required")
		}
		t.Skip("disposable PostgreSQL required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resetFeedIntegrationSchema(t, ctx, dsn)
	if err := feedmigration.Run(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	s, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	if err := s.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	sql := func(query string) {
		t.Helper()
		if _, err := s.db.ExecContext(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate a future additive migration. Older programs require their entire
	// known prefix and explicit v1 reader/writer compatibility, not equal counts.
	sql(`CREATE TABLE feed.compatibility_additive_probe(id bigint); INSERT INTO feed.schema_migrations(version,name) VALUES(9999,'9999_additive_probe.sql')`)
	if err := s.Ping(ctx); err != nil {
		t.Fatal("additive compatibility", err)
	}
	sql(`UPDATE feed.schema_compatibility SET min_writer_contract=2,max_writer_contract=2 WHERE singleton`)
	if err := s.Ping(ctx); err == nil {
		t.Fatal("incompatible writer accepted")
	}
	sql(`UPDATE feed.schema_compatibility SET min_writer_contract=1,max_writer_contract=1 WHERE singleton`)
	sql(`UPDATE feed.schema_migrations SET name='0015_mismatched.sql' WHERE version=15`)
	if err := s.Ping(ctx); err == nil {
		t.Fatal("changed known migration accepted")
	}
}
