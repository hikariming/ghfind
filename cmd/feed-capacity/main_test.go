package main

import "testing"

func TestCapacityRejectsProductionOrConnectionOverrides(t *testing.T) {
	for _, dsn := range []string{"postgres://u:p@db.example.org/db_test", "postgres://u:p@127.0.0.1/production", "postgres://u:p@127.0.0.1/db_test?host=db.example.org", "postgres://u:p@127.0.0.1/db_test?dbname=production", "postgres://u:p@127.0.0.1/db_test#fragment", "file:///tmp/database_test"} {
		if validateDSN(dsn) == nil {
			t.Fatalf("accepted unsafe DSN %s", dsn)
		}
	}
	for _, dsn := range []string{"postgres://u:p@127.0.0.1:55441/feed_capacity_test?sslmode=disable", "postgres://u:p@[::1]:55441/feed_capacity_test"} {
		if err := validateDSN(dsn); err != nil {
			t.Fatal(err)
		}
	}
}
