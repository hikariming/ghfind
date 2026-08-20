package feedbackup

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type commandRunner interface {
	Run(context.Context, string, []string, []string) ([]byte, error)
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args []string, env []string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Env = append(os.Environ(), env...)
	output, err := command.CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("%s failed: %w: %s", filepath.Base(name), err, strings.TrimSpace(string(output)))
	}
	return output, nil
}

func dumpFeed(ctx context.Context, runner commandRunner, databaseURL, destination string) (string, error) {
	env, _, err := postgresEnvironment(databaseURL)
	if err != nil {
		return "", err
	}
	version, err := runner.Run(ctx, "pg_dump", []string{"--version"}, nil)
	if err != nil {
		return "", err
	}
	_, err = runner.Run(ctx, "pg_dump", []string{
		"--format=custom",
		"--compress=zstd:9",
		"--no-owner",
		"--no-privileges",
		"--schema=feed",
		"--lock-wait-timeout=60000",
		"--file", destination,
	}, env)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(version)), nil
}

func inspectDump(ctx context.Context, runner commandRunner, archive string) error {
	output, err := runner.Run(ctx, "pg_restore", []string{"--list", archive}, nil)
	if err != nil {
		return err
	}
	contents := string(output)
	required := []string{"SCHEMA - feed", "TABLE feed projects", "TABLE feed schema_migrations"}
	for _, marker := range required {
		if !strings.Contains(contents, marker) {
			return fmt.Errorf("archive validation failed: missing %q", marker)
		}
	}
	return nil
}

func restoreFeed(ctx context.Context, runner commandRunner, databaseURL, archive string) error {
	env, database, err := postgresEnvironment(databaseURL)
	if err != nil {
		return err
	}
	_, err = runner.Run(ctx, "pg_restore", []string{
		"--clean",
		"--if-exists",
		"--no-owner",
		"--no-privileges",
		"--exit-on-error",
		"--single-transaction",
		"--dbname", database,
		archive,
	}, env)
	return err
}

// postgresEnvironment keeps credentials out of process arguments and logs.
func postgresEnvironment(databaseURL string) ([]string, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(databaseURL))
	if err != nil {
		return nil, "", fmt.Errorf("parse PostgreSQL URL: %w", err)
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return nil, "", errors.New("database URL must use postgres or postgresql")
	}
	if parsed.Hostname() == "" || parsed.User == nil || strings.TrimPrefix(parsed.Path, "/") == "" {
		return nil, "", errors.New("database URL must include host, user, and database")
	}
	password, _ := parsed.User.Password()
	port := parsed.Port()
	if port == "" {
		port = "5432"
	}
	database := strings.TrimPrefix(parsed.EscapedPath(), "/")
	unescapedDatabase, err := url.PathUnescape(database)
	if err != nil {
		return nil, "", errors.New("invalid escaped database name")
	}
	sslmode := parsed.Query().Get("sslmode")
	if sslmode == "" {
		sslmode = "require"
	}
	env := []string{
		"PGHOST=" + parsed.Hostname(),
		"PGPORT=" + port,
		"PGUSER=" + parsed.User.Username(),
		"PGPASSWORD=" + password,
		"PGDATABASE=" + unescapedDatabase,
		"PGSSLMODE=" + sslmode,
	}
	return env, unescapedDatabase, nil
}

func sameDatabase(left, right string) bool {
	leftURL, leftErr := url.Parse(left)
	rightURL, rightErr := url.Parse(right)
	if leftErr != nil || rightErr != nil {
		return true
	}
	leftPort, rightPort := leftURL.Port(), rightURL.Port()
	if leftPort == "" {
		leftPort = "5432"
	}
	if rightPort == "" {
		rightPort = "5432"
	}
	return strings.EqualFold(leftURL.Hostname(), rightURL.Hostname()) &&
		leftPort == rightPort &&
		strings.TrimPrefix(leftURL.Path, "/") == strings.TrimPrefix(rightURL.Path, "/")
}
