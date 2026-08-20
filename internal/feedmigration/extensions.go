package feedmigration

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const ExtensionBootstrapAcknowledgement = "I_UNDERSTAND_THIS_RUNS_PRIVILEGED_DDL"

var requiredExtensions = []struct {
	name      string
	statement string
}{
	{name: "vector", statement: `CREATE EXTENSION IF NOT EXISTS vector`},
	{name: "btree_gin", statement: `CREATE EXTENSION IF NOT EXISTS btree_gin`},
}

// BootstrapRequiredExtensions performs the privileged, operator-triggered
// database bootstrap that normal migrations deliberately refuse to perform.
// It must only be exposed through the one-shot feed-bootstrap role.
func BootstrapRequiredExtensions(ctx context.Context, databaseURL, acknowledgement string) error {
	if strings.TrimSpace(acknowledgement) != ExtensionBootstrapAcknowledgement {
		return fmt.Errorf("FEED_EXTENSION_BOOTSTRAP_ACK must explicitly acknowledge privileged DDL")
	}
	if strings.TrimSpace(databaseURL) == "" {
		return fmt.Errorf("FEED_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open Feed PostgreSQL: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping Feed PostgreSQL: %w", err)
	}
	for _, extension := range requiredExtensions {
		if _, err := db.ExecContext(ctx, extension.statement); err != nil {
			return fmt.Errorf("install PostgreSQL extension %s: %w", extension.name, err)
		}
	}
	return nil
}
