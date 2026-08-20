package feedbackup

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const manifestVersion = 1

type Manifest struct {
	Version         int       `json:"version"`
	BackupID        string    `json:"backupId"`
	Schema          string    `json:"schema"`
	ArchiveKey      string    `json:"archiveKey"`
	ManifestKey     string    `json:"manifestKey"`
	CreatedAt       time.Time `json:"createdAt"`
	CompletedAt     time.Time `json:"completedAt"`
	PGDumpVersion   string    `json:"pgDumpVersion"`
	PlainSHA256     string    `json:"plainSha256"`
	EncryptedSHA256 string    `json:"encryptedSha256"`
	PlainSize       int64     `json:"plainSize"`
	EncryptedSize   int64     `json:"encryptedSize"`
	Encryption      string    `json:"encryption"`
	Compression     string    `json:"compression"`
}

type BackupResult struct {
	Manifest Manifest
	Deleted  int
}

type VerifyResult struct {
	Manifest Manifest
	Archive  string
}

type Service struct {
	config Config
	store  ObjectStore
	runner commandRunner
	now    func() time.Time
}

func NewService(config Config, store ObjectStore) *Service {
	return &Service{config: config, store: store, runner: execRunner{}, now: time.Now}
}

func (service *Service) Backup(ctx context.Context) (BackupResult, error) {
	if service.config.DatabaseURL == "" {
		return BackupResult{}, errors.New("FEED_DATABASE_URL is required for backup")
	}
	if _, _, err := postgresEnvironment(service.config.DatabaseURL); err != nil {
		return BackupResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, service.config.Timeout)
	defer cancel()

	temporary, err := os.MkdirTemp("", "ghfind-feed-backup-*")
	if err != nil {
		return BackupResult{}, err
	}
	defer os.RemoveAll(temporary)

	createdAt := service.now().UTC()
	backupID, err := newBackupID(createdAt)
	if err != nil {
		return BackupResult{}, err
	}
	archive := filepath.Join(temporary, "feed.dump")
	pgDumpVersion, err := dumpFeed(ctx, service.runner, service.config.DatabaseURL, archive)
	if err != nil {
		return BackupResult{}, fmt.Errorf("create feed schema dump: %w", err)
	}
	if err := inspectDump(ctx, service.runner, archive); err != nil {
		return BackupResult{}, err
	}

	plainFile, err := os.Open(archive)
	if err != nil {
		return BackupResult{}, err
	}
	plainInfo, err := plainFile.Stat()
	if err != nil {
		plainFile.Close()
		return BackupResult{}, err
	}
	plainHash := sha256.New()

	encryptedPath := filepath.Join(temporary, "feed.dump.enc")
	encryptedFile, err := os.OpenFile(encryptedPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return BackupResult{}, err
	}
	encryptedHash := sha256.New()
	if err := encryptChunks(io.MultiWriter(encryptedFile, encryptedHash), io.TeeReader(plainFile, plainHash), service.config.EncryptionKey, defaultChunkSize); err != nil {
		plainFile.Close()
		encryptedFile.Close()
		return BackupResult{}, fmt.Errorf("encrypt feed dump: %w", err)
	}
	if err := plainFile.Close(); err != nil {
		encryptedFile.Close()
		return BackupResult{}, err
	}
	if err := encryptedFile.Sync(); err != nil {
		encryptedFile.Close()
		return BackupResult{}, err
	}
	encryptedInfo, err := encryptedFile.Stat()
	if err != nil {
		encryptedFile.Close()
		return BackupResult{}, err
	}
	if _, err := encryptedFile.Seek(0, io.SeekStart); err != nil {
		encryptedFile.Close()
		return BackupResult{}, err
	}

	baseKey := fmt.Sprintf("%s/%s/%s", service.config.Prefix, createdAt.Format("2006/01/02"), backupID)
	archiveKey := baseKey + ".dump.enc"
	manifestKey := baseKey + ".manifest.json"
	plainDigest := hex.EncodeToString(plainHash.Sum(nil))
	encryptedDigest := hex.EncodeToString(encryptedHash.Sum(nil))
	metadata := map[string]string{
		"backup-id":    backupID,
		"schema":       "feed",
		"sha256":       encryptedDigest,
		"manifest-key": manifestKey,
	}
	if err := service.store.Put(ctx, archiveKey, encryptedFile, encryptedInfo.Size(), "application/octet-stream", metadata); err != nil {
		encryptedFile.Close()
		return BackupResult{}, err
	}
	if err := encryptedFile.Close(); err != nil {
		return BackupResult{}, err
	}
	remote, err := service.store.Head(ctx, archiveKey)
	if err != nil {
		return BackupResult{}, err
	}
	if remote.Size != encryptedInfo.Size() || remote.Metadata["sha256"] != encryptedDigest {
		return BackupResult{}, fmt.Errorf("uploaded archive verification failed: expected size=%d sha256=%s", encryptedInfo.Size(), encryptedDigest)
	}
	// The remote-read verification below is authoritative. Drop both local
	// copies first so peak ephemeral disk remains about two compressed archives
	// instead of four for a large Feed database.
	if err := os.Remove(archive); err != nil {
		return BackupResult{}, err
	}
	if err := os.Remove(encryptedPath); err != nil {
		return BackupResult{}, err
	}

	manifest := Manifest{
		Version:         manifestVersion,
		BackupID:        backupID,
		Schema:          "feed",
		ArchiveKey:      archiveKey,
		ManifestKey:     manifestKey,
		CreatedAt:       createdAt,
		PGDumpVersion:   pgDumpVersion,
		PlainSHA256:     plainDigest,
		EncryptedSHA256: encryptedDigest,
		PlainSize:       plainInfo.Size(),
		EncryptedSize:   encryptedInfo.Size(),
		Encryption:      "AES-256-GCM/chunked-v1",
		Compression:     "pg_dump-custom-zstd-9",
	}
	// Verify the bytes by downloading them from the object store, checking both
	// hashes, decrypting, and asking pg_restore to parse the archive. Only then
	// publish the .manifest.json completion marker.
	remoteVerifyDirectory := filepath.Join(temporary, "remote-verify")
	if err := os.Mkdir(remoteVerifyDirectory, 0o700); err != nil {
		return BackupResult{}, err
	}
	if _, err := service.verifyManifestArchive(ctx, manifest, remoteVerifyDirectory); err != nil {
		return BackupResult{}, fmt.Errorf("verify uploaded backup: %w", err)
	}
	manifest.CompletedAt = service.now().UTC()
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return BackupResult{}, err
	}
	if err := service.store.Put(ctx, manifestKey, strings.NewReader(string(manifestJSON)), int64(len(manifestJSON)), "application/json", map[string]string{
		"backup-id": backupID,
		"complete":  "true",
	}); err != nil {
		return BackupResult{}, err
	}
	manifestRemote, err := service.store.Head(ctx, manifestKey)
	if err != nil {
		return BackupResult{}, err
	}
	if manifestRemote.Size != int64(len(manifestJSON)) {
		return BackupResult{}, errors.New("uploaded manifest size mismatch")
	}

	deleted, err := service.applyRetention(ctx, archiveKey, manifestKey)
	if err != nil {
		return BackupResult{}, err
	}
	return BackupResult{Manifest: manifest, Deleted: deleted}, nil
}

func (service *Service) Verify(ctx context.Context) (VerifyResult, error) {
	ctx, cancel := context.WithTimeout(ctx, service.config.Timeout)
	defer cancel()
	temporary, err := os.MkdirTemp("", "ghfind-feed-verify-*")
	if err != nil {
		return VerifyResult{}, err
	}
	defer os.RemoveAll(temporary)
	result, err := service.verifyToDirectory(ctx, temporary)
	if err != nil {
		return VerifyResult{}, err
	}
	result.Archive = ""
	return result, nil
}

func (service *Service) Restore(ctx context.Context) (VerifyResult, error) {
	if service.config.DatabaseURL == "" {
		return VerifyResult{}, errors.New("FEED_DATABASE_URL is required as the restore source safety identity")
	}
	if service.config.TargetDatabaseURL == "" {
		return VerifyResult{}, errors.New("FEED_RESTORE_TARGET_DATABASE_URL is required")
	}
	if service.config.RestoreAck != restoreConfirmation {
		return VerifyResult{}, fmt.Errorf("FEED_RESTORE_ACK must equal %q", restoreConfirmation)
	}
	if sameDatabase(service.config.DatabaseURL, service.config.TargetDatabaseURL) {
		return VerifyResult{}, errors.New("restore target resolves to the source Feed database")
	}
	ctx, cancel := context.WithTimeout(ctx, service.config.Timeout)
	defer cancel()
	temporary, err := os.MkdirTemp("", "ghfind-feed-restore-*")
	if err != nil {
		return VerifyResult{}, err
	}
	defer os.RemoveAll(temporary)
	result, err := service.verifyToDirectory(ctx, temporary)
	if err != nil {
		return VerifyResult{}, err
	}
	if err := restoreFeed(ctx, service.runner, service.config.TargetDatabaseURL, result.Archive); err != nil {
		return VerifyResult{}, fmt.Errorf("restore feed schema: %w", err)
	}
	return result, nil
}

func (service *Service) verifyToDirectory(ctx context.Context, directory string) (VerifyResult, error) {
	manifestKey := service.config.ManifestKey
	if manifestKey == "" {
		objects, err := service.store.List(ctx, service.config.Prefix+"/")
		if err != nil {
			return VerifyResult{}, err
		}
		manifests := make([]ObjectInfo, 0)
		for _, object := range objects {
			if strings.HasSuffix(object.Key, ".manifest.json") {
				manifests = append(manifests, object)
			}
		}
		if len(manifests) == 0 {
			return VerifyResult{}, errors.New("no completed backup manifests found")
		}
		sort.Slice(manifests, func(i, j int) bool { return manifests[i].LastModified.After(manifests[j].LastModified) })
		manifestKey = manifests[0].Key
	}

	body, _, err := service.store.Get(ctx, manifestKey)
	if err != nil {
		return VerifyResult{}, err
	}
	manifestBytes, readErr := io.ReadAll(io.LimitReader(body, 1<<20))
	closeErr := body.Close()
	if readErr != nil {
		return VerifyResult{}, readErr
	}
	if closeErr != nil {
		return VerifyResult{}, closeErr
	}
	var manifest Manifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return VerifyResult{}, fmt.Errorf("decode backup manifest: %w", err)
	}
	if manifest.Version != manifestVersion || manifest.Schema != "feed" || manifest.ManifestKey != manifestKey || manifest.ArchiveKey == "" {
		return VerifyResult{}, errors.New("backup manifest contract mismatch")
	}

	return service.verifyManifestArchive(ctx, manifest, directory)
}

func (service *Service) verifyManifestArchive(ctx context.Context, manifest Manifest, directory string) (VerifyResult, error) {
	encryptedBody, remote, err := service.store.Get(ctx, manifest.ArchiveKey)
	if err != nil {
		return VerifyResult{}, err
	}
	encryptedPath := filepath.Join(directory, "feed.dump.enc")
	encryptedFile, err := os.OpenFile(encryptedPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		encryptedBody.Close()
		return VerifyResult{}, err
	}
	encryptedHash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(encryptedFile, encryptedHash), encryptedBody)
	closeBodyErr := encryptedBody.Close()
	closeFileErr := encryptedFile.Close()
	if copyErr != nil {
		return VerifyResult{}, copyErr
	}
	if closeBodyErr != nil {
		return VerifyResult{}, closeBodyErr
	}
	if closeFileErr != nil {
		return VerifyResult{}, closeFileErr
	}
	if written != manifest.EncryptedSize || (remote.Size > 0 && remote.Size != manifest.EncryptedSize) || hex.EncodeToString(encryptedHash.Sum(nil)) != manifest.EncryptedSHA256 {
		return VerifyResult{}, errors.New("encrypted archive size or SHA-256 mismatch")
	}

	encryptedFile, err = os.Open(encryptedPath)
	if err != nil {
		return VerifyResult{}, err
	}
	archive := filepath.Join(directory, "feed.dump")
	plainFile, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		encryptedFile.Close()
		return VerifyResult{}, err
	}
	plainHash := sha256.New()
	decryptErr := decryptChunks(io.MultiWriter(plainFile, plainHash), encryptedFile, service.config.EncryptionKey)
	closeEncryptedErr := encryptedFile.Close()
	closePlainErr := plainFile.Close()
	if decryptErr != nil {
		return VerifyResult{}, decryptErr
	}
	if closeEncryptedErr != nil {
		return VerifyResult{}, closeEncryptedErr
	}
	if closePlainErr != nil {
		return VerifyResult{}, closePlainErr
	}
	plainInfo, err := os.Stat(archive)
	if err != nil {
		return VerifyResult{}, err
	}
	if plainInfo.Size() != manifest.PlainSize || hex.EncodeToString(plainHash.Sum(nil)) != manifest.PlainSHA256 {
		return VerifyResult{}, errors.New("decrypted archive size or SHA-256 mismatch")
	}
	if err := inspectDump(ctx, service.runner, archive); err != nil {
		return VerifyResult{}, err
	}
	return VerifyResult{Manifest: manifest, Archive: archive}, nil
}

func (service *Service) applyRetention(ctx context.Context, currentKeys ...string) (int, error) {
	objects, err := service.store.List(ctx, service.config.Prefix+"/")
	if err != nil {
		return 0, err
	}
	current := make(map[string]struct{}, len(currentKeys))
	for _, key := range currentKeys {
		current[key] = struct{}{}
	}
	cutoff := service.now().UTC().Add(-service.config.Retention)
	deleted := 0
	for _, object := range objects {
		if _, keep := current[object.Key]; keep || object.LastModified.IsZero() || !object.LastModified.Before(cutoff) {
			continue
		}
		if err := service.store.Delete(ctx, object.Key); err != nil {
			return deleted, err
		}
		deleted++
	}
	return deleted, nil
}

func newBackupID(timestamp time.Time) (string, error) {
	random := make([]byte, 6)
	if _, err := io.ReadFull(rand.Reader, random); err != nil {
		return "", err
	}
	return timestamp.Format("20060102T150405.000000000Z") + "-" + hex.EncodeToString(random), nil
}
