package feedbackup

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeRunner struct{ dump []byte }

func (runner fakeRunner) Run(_ context.Context, name string, arguments []string, _ []string) ([]byte, error) {
	if name == "pg_dump" && len(arguments) == 1 && arguments[0] == "--version" {
		return []byte("pg_dump (PostgreSQL) 17.6\n"), nil
	}
	if name == "pg_dump" {
		for index, argument := range arguments {
			if argument == "--file" && index+1 < len(arguments) {
				return nil, os.WriteFile(arguments[index+1], runner.dump, 0o600)
			}
		}
		return nil, fmt.Errorf("missing --file")
	}
	if name == "pg_restore" && len(arguments) > 0 && arguments[0] == "--list" {
		return []byte("SCHEMA - feed\nTABLE feed projects\nTABLE feed schema_migrations\n"), nil
	}
	return nil, fmt.Errorf("unexpected command %s %v", name, arguments)
}

type memoryObject struct {
	data        []byte
	contentType string
	metadata    map[string]string
	modified    time.Time
}

type memoryStore struct {
	mu      sync.Mutex
	objects map[string]memoryObject
	now     time.Time
}

func newMemoryStore(now time.Time) *memoryStore {
	return &memoryStore{objects: make(map[string]memoryObject), now: now}
}

func (store *memoryStore) Put(_ context.Context, key string, body io.Reader, size int64, contentType string, metadata map[string]string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if int64(len(data)) != size {
		return fmt.Errorf("size mismatch")
	}
	clonedMetadata := make(map[string]string, len(metadata))
	for key, value := range metadata {
		clonedMetadata[key] = value
	}
	store.objects[key] = memoryObject{data: data, contentType: contentType, metadata: clonedMetadata, modified: store.now}
	return nil
}

func (store *memoryStore) Head(_ context.Context, key string) (ObjectInfo, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	object, ok := store.objects[key]
	if !ok {
		return ObjectInfo{}, fmt.Errorf("not found")
	}
	return ObjectInfo{Key: key, Size: int64(len(object.data)), LastModified: object.modified, Metadata: object.metadata}, nil
}

func (store *memoryStore) Get(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error) {
	info, err := store.Head(ctx, key)
	if err != nil {
		return nil, ObjectInfo{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return io.NopCloser(bytes.NewReader(store.objects[key].data)), info, nil
}

func (store *memoryStore) List(_ context.Context, prefix string) ([]ObjectInfo, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	objects := make([]ObjectInfo, 0)
	for key, object := range store.objects {
		if strings.HasPrefix(key, prefix) {
			objects = append(objects, ObjectInfo{Key: key, Size: int64(len(object.data)), LastModified: object.modified})
		}
	}
	return objects, nil
}

func (store *memoryStore) Delete(_ context.Context, key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.objects, key)
	return nil
}

func TestBackupThenVerifyAndRetention(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 14, 6, 17, 0, 0, time.UTC)
	store := newMemoryStore(now)
	store.objects["feed-postgres/old.dump.enc"] = memoryObject{data: []byte("old"), modified: now.Add(-36 * 24 * time.Hour)}
	config := Config{
		DatabaseURL:   "postgres://feed:secret@postgres.internal/ghfind_feed?sslmode=disable",
		EncryptionKey: bytes.Repeat([]byte{0x33}, 32),
		Prefix:        "feed-postgres",
		Retention:     35 * 24 * time.Hour,
		Timeout:       time.Minute,
	}
	service := NewService(config, store)
	service.runner = fakeRunner{dump: bytes.Repeat([]byte("custom-format-dump"), 10_000)}
	service.now = func() time.Time { return now }

	backup, err := service.Backup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if backup.Deleted != 1 {
		t.Fatalf("deleted=%d, want 1", backup.Deleted)
	}
	if _, ok := store.objects[backup.Manifest.ArchiveKey]; !ok {
		t.Fatal("archive was not uploaded")
	}
	if _, ok := store.objects[backup.Manifest.ManifestKey]; !ok {
		t.Fatal("completion manifest was not uploaded")
	}

	verifyService := NewService(config, store)
	verifyService.runner = fakeRunner{}
	verified, err := verifyService.Verify(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if verified.Manifest.BackupID != backup.Manifest.BackupID {
		t.Fatalf("verified backup=%q, want %q", verified.Manifest.BackupID, backup.Manifest.BackupID)
	}
}

func TestRestoreRequiresExplicitDifferentTarget(t *testing.T) {
	t.Parallel()
	service := NewService(Config{
		DatabaseURL:       "postgres://feed@db/feed",
		TargetDatabaseURL: "postgres://other@db/feed",
		RestoreAck:        restoreConfirmation,
	}, newMemoryStore(time.Now()))
	if _, err := service.Restore(context.Background()); err == nil || !strings.Contains(err.Error(), "source") {
		t.Fatalf("expected same-source refusal, got %v", err)
	}
}
