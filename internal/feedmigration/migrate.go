package feedmigration

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed migrations/*.sql
var migrations embed.FS

type migration struct {
	version int64
	name    string
	body    string
}

func Run(ctx context.Context, databaseURL string) error {
	if strings.TrimSpace(databaseURL) == "" {
		return fmt.Errorf("FEED_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open Feed PostgreSQL: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(time.Minute)
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping Feed PostgreSQL: %w", err)
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("reserve migration connection: %w", err)
	}
	defer conn.Close()
	var vectorInstalled bool
	if err := conn.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector')`).Scan(&vectorInstalled); err != nil {
		return fmt.Errorf("verify pgvector extension: %w", err)
	}
	if !vectorInstalled {
		return fmt.Errorf("pgvector extension is required; an operator must enable vector before running Feed migrations")
	}
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock(hashtext('ghfind_feed_migrations_v1'))`); err != nil {
		return fmt.Errorf("lock Feed migrations: %w", err)
	}
	defer conn.ExecContext(context.Background(), `SELECT pg_advisory_unlock(hashtext('ghfind_feed_migrations_v1'))`) //nolint:errcheck
	if _, err := conn.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS feed;
CREATE TABLE IF NOT EXISTS feed.schema_migrations (
  version BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`); err != nil {
		return fmt.Errorf("bootstrap Feed migration ledger: %w", err)
	}
	items, err := loadMigrations()
	if err != nil {
		return err
	}
	for _, item := range items {
		var exists bool
		if err := conn.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM feed.schema_migrations WHERE version = $1)`, item.version).Scan(&exists); err != nil {
			return fmt.Errorf("read migration %d state: %w", item.version, err)
		}
		if exists {
			continue
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %d: %w", item.version, err)
		}
		if _, err := tx.ExecContext(ctx, item.body); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", item.name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO feed.schema_migrations(version, name) VALUES ($1, $2)`, item.version, item.name); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("record migration %s: %w", item.name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", item.name, err)
		}
	}
	return nil
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return nil, fmt.Errorf("read embedded Feed migrations: %w", err)
	}
	items := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(entry.Name(), "_")
		if !ok {
			return nil, fmt.Errorf("migration %q has no numeric prefix", entry.Name())
		}
		version, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil || version < 1 {
			return nil, fmt.Errorf("migration %q has invalid version", entry.Name())
		}
		body, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %q: %w", entry.Name(), err)
		}
		items = append(items, migration{version: version, name: entry.Name(), body: string(body)})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].version < items[j].version })
	for index := 1; index < len(items); index++ {
		if items[index-1].version == items[index].version {
			return nil, fmt.Errorf("duplicate Feed migration version %d", items[index].version)
		}
	}
	return items, nil
}
