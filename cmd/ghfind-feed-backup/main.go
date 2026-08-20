package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/hikariming/ghfind/internal/feedbackup"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(context.Background(), logger, os.Args[1:]); err != nil {
		logger.Error("Feed backup command failed", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, logger *slog.Logger, arguments []string) error {
	action := "backup"
	if len(arguments) > 0 {
		action = arguments[0]
	}
	config, err := feedbackup.LoadConfig()
	if err != nil {
		return err
	}
	store, err := feedbackup.NewS3Store(ctx, config)
	if err != nil {
		return err
	}
	service := feedbackup.NewService(config, store)

	switch action {
	case "backup":
		result, err := service.Backup(ctx)
		if err != nil {
			return err
		}
		logger.Info("Feed PostgreSQL logical backup completed",
			"backup_id", result.Manifest.BackupID,
			"manifest_key", result.Manifest.ManifestKey,
			"encrypted_bytes", result.Manifest.EncryptedSize,
			"retention_objects_deleted", result.Deleted,
		)
	case "verify":
		result, err := service.Verify(ctx)
		if err != nil {
			return err
		}
		logger.Info("Feed PostgreSQL backup verified",
			"backup_id", result.Manifest.BackupID,
			"manifest_key", result.Manifest.ManifestKey,
			"plain_bytes", result.Manifest.PlainSize,
		)
	case "restore":
		result, err := service.Restore(ctx)
		if err != nil {
			return err
		}
		logger.Info("Feed PostgreSQL backup restored to explicit target",
			"backup_id", result.Manifest.BackupID,
			"manifest_key", result.Manifest.ManifestKey,
		)
	default:
		return &usageError{action: action}
	}
	return nil
}

type usageError struct{ action string }

func (err *usageError) Error() string {
	return "unknown action " + err.action + "; expected backup, verify, or restore"
}
