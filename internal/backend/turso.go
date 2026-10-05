package backend

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/tursodatabase/libsql-client-go/libsql"
)

// TursoStore uses the official remote libSQL driver and existing credentials.
type TursoStore struct {
	db *sql.DB
}

func OpenTursoStore(config Config) (*TursoStore, error) {
	dsn, err := config.LibSQLDSN()
	if err != nil {
		return nil, err
	}
	options := []libsql.Option{}
	if config.TursoAuth != "" && !strings.HasPrefix(dsn, "file:") {
		options = append(options, libsql.WithAuthToken(config.TursoAuth))
	}
	connector, err := libsql.NewConnector(dsn, options...)
	if err != nil {
		return nil, fmt.Errorf("create libsql connector: %w", err)
	}
	db := sql.OpenDB(connector)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetMaxIdleConns(4)
	db.SetMaxOpenConns(16)
	return &TursoStore{db: db}, nil
}

func (s *TursoStore) Close() error { return s.db.Close() }

func (s *TursoStore) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}
