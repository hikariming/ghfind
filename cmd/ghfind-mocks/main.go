// Command ghfind-mocks is the staging-only mock dependency service. It
// provisions the mock Turso schema (idempotent, retrying until the libsql
// server is reachable) and then serves the Upstash REST mock on the same
// port. Nothing here is used in production.
package main

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/hikariming/ghfind/internal/mockupstash"
	"github.com/tursodatabase/libsql-client-go/libsql"
)

//go:embed schema.sql
var schemaFS embed.FS

func main() {
	store := mockupstash.New()
	http.HandleFunc("/", store.HandleHTTP)
	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "ok")
	})

	go provisionSchema()

	addr := os.Getenv("PORT")
	if addr == "" {
		addr = ":8000"
	}
	if addr[0] != ':' {
		addr = ":" + addr
	}
	log.Printf("ghfind-mocks listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func provisionSchema() {
	dsn := os.Getenv("TURSO_DATABASE_URL")
	if dsn == "" {
		log.Print("TURSO_DATABASE_URL not set; skipping schema provisioning")
		return
	}
	schema, err := schemaFS.ReadFile("schema.sql")
	if err != nil {
		log.Fatalf("read schema.sql: %v", err)
	}
	deadline := time.Now().Add(5 * time.Minute)
	for attempt := 1; ; attempt++ {
		if err := applySchema(dsn, schema); err != nil {
			if time.Now().After(deadline) {
				log.Fatalf("apply schema: %v", err)
			}
			log.Printf("schema attempt %d failed (%v); retrying", attempt, err)
			time.Sleep(3 * time.Second)
			continue
		}
		log.Printf("schema applied on attempt %d", attempt)
		return
	}
}

// extraColumns are ALTER TABLE migrations for mock databases created before a
// column was added to schema.sql. CREATE TABLE IF NOT EXISTS never alters an
// existing table, so these keep running databases convergent; duplicate-column
// errors are expected on the first run after the columns already exist.
var extraColumns = [][3]string{
	{"scores", "prev_score", "REAL"},
	{"scores", "prev_scanned_at", "INTEGER"},
}

func applySchema(dsn string, schema []byte) error {
	connector, err := libsql.NewConnector(dsn)
	if err != nil {
		return fmt.Errorf("create libsql connector: %w", err)
	}
	db := sql.OpenDB(connector)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, string(schema)); err != nil {
		return fmt.Errorf("execute schema: %w", err)
	}
	for _, column := range extraColumns {
		statement := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", column[0], column[1], column[2])
		if _, err := db.ExecContext(ctx, statement); err != nil && !isDuplicateColumn(err) {
			return fmt.Errorf("add column %s.%s: %w", column[0], column[1], err)
		}
	}
	return nil
}

func isDuplicateColumn(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "duplicate column")
}
