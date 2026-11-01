package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrScanCursorConflict is a lost compare-and-swap. The caller keeps the
// public scan and retries the cursor write from a fresh load.
var ErrScanCursorConflict = errors.New("scan cursor changed")

// ScanCursorStore keeps one watermark book per user. The table is created
// on first use and does not change public_scan_runs or historical snapshots.
type ScanCursorStore interface {
	EnsureScanCursorSchema(context.Context) error
	LoadScanCursors(context.Context, string) (scanCursorBook, error)
	SaveScanCursors(context.Context, scanCursorBook) error
}

func (s *TursoStore) EnsureScanCursorSchema(ctx context.Context) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("scan cursor store unavailable")
	}
	s.cursorSchemaMu.Lock()
	defer s.cursorSchemaMu.Unlock()
	if s.cursorSchemaOK {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS scan_source_cursors (
      username TEXT PRIMARY KEY,
      book TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
	if err != nil {
		return fmt.Errorf("ensure scan cursor table: %w", err)
	}
	s.cursorSchemaOK = true
	return nil
}

// LoadScanCursors returns an empty book when the user has no row. A row
// that does not decode is returned as a corrupt watermark so the caller
// reconciles instead of trusting a partial book.
func (s *TursoStore) LoadScanCursors(ctx context.Context, username string) (scanCursorBook, error) {
	empty := scanCursorBook{Username: strings.ToLower(username), Schema: scanCursorSchemaVersion, Sources: map[string]scanCursorWatermark{}}
	if err := s.EnsureScanCursorSchema(ctx); err != nil {
		return empty, err
	}
	var raw string
	var updated int64
	err := s.db.QueryRowContext(ctx, `SELECT book, updated_at FROM scan_source_cursors WHERE username = ?`, strings.ToLower(username)).Scan(&raw, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return empty, nil
	}
	if err != nil {
		return empty, fmt.Errorf("read scan cursors: %w", err)
	}
	var book scanCursorBook
	if err := json.Unmarshal([]byte(raw), &book); err != nil || book.Schema != scanCursorSchemaVersion {
		// A bad row or an older cursor format is a missing book. The next
		// scan reconciles. The revision stays so the save can replace it.
		book = empty
		book.Revision = updated
		return book, nil
	}
	kept := map[string]scanCursorWatermark{}
	for name, mark := range book.Sources {
		if knownScanCursorSource(name) {
			kept[name] = mark
		}
	}
	book.Sources = kept
	book.Username = strings.ToLower(username)
	book.Revision = updated
	return book, nil
}

func (s *TursoStore) SaveScanCursors(ctx context.Context, book scanCursorBook) error {
	if err := s.EnsureScanCursorSchema(ctx); err != nil {
		return err
	}
	book.Username = strings.ToLower(book.Username)
	book.Schema = scanCursorSchemaVersion
	if book.Sources == nil {
		book.Sources = map[string]scanCursorWatermark{}
	}
	encoded, err := encodeCursorBook(book)
	if err != nil {
		return fmt.Errorf("encode scan cursors: %w", err)
	}
	now := time.Now().UTC().UnixMilli()
	if now <= book.Revision {
		now = book.Revision + 1
	}
	if book.Revision == 0 {
		result, err := s.db.ExecContext(ctx, `INSERT INTO scan_source_cursors (username, book, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO NOTHING`,
			book.Username, string(encoded), now)
		if err != nil {
			return fmt.Errorf("save scan cursors: %w", err)
		}
		inserted, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("read scan cursor insert: %w", err)
		}
		if inserted == 0 {
			return ErrScanCursorConflict
		}
		return nil
	}
	result, err := s.db.ExecContext(ctx, `UPDATE scan_source_cursors
      SET book = ?, updated_at = ?
      WHERE username = ? AND updated_at = ?`,
		string(encoded), now, book.Username, book.Revision)
	if err != nil {
		return fmt.Errorf("save scan cursors: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read scan cursor update: %w", err)
	}
	if updated == 0 {
		return ErrScanCursorConflict
	}
	return nil
}
