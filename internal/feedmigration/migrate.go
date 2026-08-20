package feedmigration

import (
	"context"
	"database/sql"
	"embed"
	"errors"
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

// RequiredMigration identifies one immutable, embedded Feed schema step. It
// is deliberately exposed instead of duplicating a "latest version" constant
// in API readiness code, where it would silently drift as migrations land.
type RequiredMigration struct {
	Version int64
	Name    string
}

// RequiredMigrations returns the exact migration ledger required by this
// binary. Callers must treat both version and name as part of the contract.
func RequiredMigrations() ([]RequiredMigration, error) {
	items, err := loadMigrations()
	if err != nil {
		return nil, err
	}
	required := make([]RequiredMigration, 0, len(items))
	for _, item := range items {
		required = append(required, RequiredMigration{Version: item.version, Name: item.name})
	}
	return required, nil
}

// LatestVersion derives the active schema requirement from the embedded files;
// it is not a hand-maintained compatibility constant.
func LatestVersion() (int64, error) {
	items, err := loadMigrations()
	if err != nil {
		return 0, err
	}
	if len(items) == 0 {
		return 0, fmt.Errorf("no embedded Feed migrations")
	}
	return items[len(items)-1].version, nil
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
	return maintainVectorIndexesConn(ctx, conn)
}

const (
	vectorHNSWMinimumProjects = 50_000
	vectorHNSWMaxDimensions   = 2_000
	halfvecHNSWMaxDimensions  = 4_000
)

// MaintainVectorIndexes is a controlled maintenance operation for the
// dedicated Feed migration role. API and worker processes never execute DDL.
// It is safe to run repeatedly: it only creates a dimension-specific HNSW
// index once an active embedding corpus is large enough to justify approximate
// retrieval. The normal migration job invokes it as well, so a subsequent
// green main deployment repairs a missing index without application code
// needing database-owner privileges.
func MaintainVectorIndexes(ctx context.Context, databaseURL string) error {
	if strings.TrimSpace(databaseURL) == "" {
		return fmt.Errorf("FEED_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open Feed PostgreSQL for vector index maintenance: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping Feed PostgreSQL for vector index maintenance: %w", err)
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("reserve vector index maintenance connection: %w", err)
	}
	defer conn.Close()
	return maintainVectorIndexesConn(ctx, conn)
}

func maintainVectorIndexesConn(ctx context.Context, conn *sql.Conn) error {
	// Migrations have not established the Feed schema yet. This is normal for a
	// brand-new database only if an earlier migration failed; preserve the
	// migration failure instead of masking it with a missing-table error.
	var projectsTable *string
	if err := conn.QueryRowContext(ctx, `SELECT to_regclass('feed.project_embeddings')::text`).Scan(&projectsTable); err != nil {
		return fmt.Errorf("check Feed vector index catalog: %w", err)
	}
	if projectsTable == nil || *projectsTable == "" {
		return nil
	}
	// This bounded tag fanout index is useful from the first non-empty catalog,
	// unlike HNSW which has a material build/memory cost. It is created by the
	// same privileged migration job and concurrently so a later repair run does
	// not block Feed event/project writes.
	if err := ensureConcurrentFeedIndex(ctx, conn, "project_tags_recall_affinity", `CREATE INDEX CONCURRENTLY IF NOT EXISTS project_tags_recall_affinity
      ON feed.project_tags (tag_id,(weight * confidence) DESC,repo_key)`); err != nil {
		return fmt.Errorf("create Feed tag recall affinity index: %w", err)
	}
	rows, err := conn.QueryContext(ctx, `SELECT dimensions,COUNT(*)
      FROM feed.project_embeddings WHERE active=true
      GROUP BY dimensions HAVING COUNT(*) >= $1 ORDER BY dimensions`, vectorHNSWMinimumProjects)
	if err != nil {
		return fmt.Errorf("find Feed vector index candidates: %w", err)
	}
	type candidate struct {
		dimensions int
		kind       string
	}
	candidates := []candidate{}
	for rows.Next() {
		var dimensions int
		var count int64
		if err := rows.Scan(&dimensions, &count); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan Feed vector index candidate: %w", err)
		}
		switch {
		case dimensions > 0 && dimensions <= vectorHNSWMaxDimensions:
			candidates = append(candidates, candidate{dimensions: dimensions, kind: "vector"})
		case dimensions > vectorHNSWMaxDimensions && dimensions <= halfvecHNSWMaxDimensions:
			candidates = append(candidates, candidate{dimensions: dimensions, kind: "halfvec"})
		// Dimensions beyond halfvec's supported HNSW bound keep the exact cosine
		// path. They must be intentionally reduced or receive a separately
		// designed retrieval backend; silently creating a wrong-distance index
		// would corrupt recommendation semantics.
		default:
			continue
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("read Feed vector index candidates: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close Feed vector index candidates: %w", err)
	}
	for _, candidate := range candidates {
		operatorClass := candidate.kind + "_cosine_ops"
		indexName := fmt.Sprintf("project_embeddings_active_hnsw_%s_d%d", candidate.kind, candidate.dimensions)
		statement := fmt.Sprintf(`CREATE INDEX CONCURRENTLY IF NOT EXISTS %s
          ON feed.project_embeddings USING hnsw ((embedding::%s(%d)) %s)
          WITH (m=16,ef_construction=64)
          WHERE active=true AND dimensions=%d`,
			indexName, candidate.kind, candidate.dimensions, operatorClass, candidate.dimensions)
		if err := ensureConcurrentFeedIndex(ctx, conn, indexName, statement); err != nil {
			return fmt.Errorf("create Feed %s HNSW index for %d dimensions: %w", candidate.kind, candidate.dimensions, err)
		}
	}
	return nil
}

func ensureConcurrentFeedIndex(ctx context.Context, conn *sql.Conn, indexName, createStatement string) error {
	var valid bool
	err := conn.QueryRowContext(ctx, `SELECT index_info.indisvalid
      FROM pg_class index_class
      JOIN pg_namespace namespace ON namespace.oid=index_class.relnamespace
      JOIN pg_index index_info ON index_info.indexrelid=index_class.oid
      WHERE namespace.nspname='feed' AND index_class.relname=$1`, indexName).Scan(&valid)
	if err == nil && valid {
		return nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("inspect index %s: %w", indexName, err)
	}
	if !errors.Is(err, sql.ErrNoRows) && !valid {
		// CREATE INDEX CONCURRENTLY can leave an invalid shell after a cancellation
		// or connection loss. Dropping only that deterministic index name lets the
		// next controlled migration job self-heal instead of silently retaining a
		// non-usable index because IF NOT EXISTS would skip it.
		if _, err := conn.ExecContext(ctx, `DROP INDEX CONCURRENTLY IF EXISTS feed.`+indexName); err != nil {
			return fmt.Errorf("drop invalid index %s: %w", indexName, err)
		}
	}
	if _, err := conn.ExecContext(ctx, createStatement); err != nil {
		return fmt.Errorf("create index %s: %w", indexName, err)
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
