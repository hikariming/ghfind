package feedbackup

import (
	"strings"
	"testing"
)

func TestPostgresEnvironmentKeepsPasswordOutOfArguments(t *testing.T) {
	t.Parallel()
	environment, database, err := postgresEnvironment("postgres://feed:p%40ss@db.internal:6543/ghfind_feed?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	if database != "ghfind_feed" {
		t.Fatalf("database=%q", database)
	}
	joined := strings.Join(environment, "\n")
	for _, expected := range []string{"PGHOST=db.internal", "PGPORT=6543", "PGUSER=feed", "PGPASSWORD=p@ss", "PGDATABASE=ghfind_feed", "PGSSLMODE=disable"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in environment", expected)
		}
	}
}

func TestSameDatabaseIgnoresCredentials(t *testing.T) {
	t.Parallel()
	if !sameDatabase("postgres://a:one@db:5432/feed", "postgresql://b:two@DB/feed?sslmode=require") {
		t.Fatal("same host/port/database must be treated as the same destructive target")
	}
	if sameDatabase("postgres://a@db/feed", "postgres://a@db/scratch") {
		t.Fatal("different database names must be allowed")
	}
}
