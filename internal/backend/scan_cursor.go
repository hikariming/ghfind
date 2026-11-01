package backend

import (
	"encoding/json"
	"strings"
	"time"
)

// Cursor sources name one independently resumable pull. They line up with
// the Phase 2 part names so a split scan can advance one source at a time.
const (
	scanCursorRepos    = scanPartRepos
	scanCursorExternal = scanPartExternal
	scanCursorMerged   = scanPartMerged
	scanCursorCommits  = scanPartCommits
	scanCursorWorkflow = scanPartWorkflows

	// scanCursorSchemaVersion is the cursor row format, not the public
	// collection version. Collection stays v7 while snapshot and coverage
	// contracts are unchanged.
	scanCursorSchemaVersion = 1
)

// scanCursorWatermark is the newest pushedAt or mergedAt on one source.
// Resume does not use GraphQL endCursor. Repo pages are ordered by
// PUSHED_AT, so a later scan stops once pushedAt is older than Watermark.
// Items that share Watermark's timestamp are kept and deduped by stable id,
// because a page can stop in the middle of one second. Merged and external
// PR connections are ordered by created time, not mergedAt, so those
// sources are not resumed; each scan reads their existing window.
type scanCursorWatermark struct {
	Source          string `json:"source"`
	Watermark       string `json:"watermark,omitempty"`
	Collection      string `json:"collection"`
	IncrementalRuns int    `json:"incremental_runs"`
	ReconciledAt    string `json:"reconciled_at,omitempty"`
	UpdatedAt       string `json:"updated_at,omitempty"`
	// Repos and Nodes are the last merged source page. They stay in the
	// cursor table so a later delta can be merged without rewriting the
	// public snapshot contract. ForkCount is the inventory total from the
	// last full read of that source; an incremental page does not replace it.
	Repos     []githubRepo   `json:"repos,omitempty"`
	Nodes     []mergedPRNode `json:"nodes,omitempty"`
	ForkCount float64        `json:"fork_count,omitempty"`
}

func (w scanCursorWatermark) valid() bool {
	if strings.TrimSpace(w.Source) == "" || strings.TrimSpace(w.Watermark) == "" {
		return false
	}
	if _, ok := parseTimestamp(&w.Watermark); !ok {
		return false
	}
	if w.Collection != "" && w.Collection != goCanonicalCollectionVersion {
		return false
	}
	return true
}

// scanCursorBook is the per-user set of source watermarks. A missing or
// unreadable book means the next scan is a full reconciliation.
type scanCursorBook struct {
	Username string                         `json:"username"`
	Schema   int                            `json:"schema"`
	Sources  map[string]scanCursorWatermark `json:"sources"`
	// Revision is the row updated_at observed by the last load. Save
	// writes only when the row still has this value. It is not part of
	// the stored JSON.
	Revision int64 `json:"-"`
}

func (b scanCursorBook) source(name string) (scanCursorWatermark, bool) {
	if b.Sources == nil {
		return scanCursorWatermark{}, false
	}
	mark, ok := b.Sources[name]
	if !ok || !mark.valid() {
		return scanCursorWatermark{}, false
	}
	return mark, true
}

func (b scanCursorBook) raw(name string) scanCursorWatermark {
	if b.Sources == nil {
		return scanCursorWatermark{}
	}
	return b.Sources[name]
}

// scanReconcileReason says why the next scan must pull the full source
// instead of the cursor delta. Empty means an incremental pull is allowed.
type scanReconcileReason string

const (
	scanReconcileNone     scanReconcileReason = ""
	scanReconcileMissing  scanReconcileReason = "cursor_missing"
	scanReconcileCorrupt  scanReconcileReason = "cursor_corrupt"
	scanReconcileVersion  scanReconcileReason = "collection_version"
	scanReconcileRunCount scanReconcileReason = "incremental_run_count"
	scanReconcileAge      scanReconcileReason = "cursor_age"
)

// scanIncrementalReconcileEveryN is how many successful incremental scans
// may land before the next one re-reads the whole source. The count is
// StatusTTL / #580's 24h manual rescan cooldown: seven days of daily
// rescans, then a full reconcile. It is not tuned per account.
func scanIncrementalReconcileEveryN() int {
	days := int(defaultStatusTTL / roastFreshness)
	if days < 1 {
		return 1
	}
	return days
}

// scanIncrementalReconcileAge is how old a cursor may be before the next
// scan re-reads the source. It is StatusTTL itself (the existing job-status
// freshness window), not a new production knob.
func scanIncrementalReconcileAge() time.Duration {
	return defaultStatusTTL
}

// decideScanReconcile picks a full pull when the cursor is missing, the
// stored collection version is not the current one, the incremental streak
// has reached the derived count, or the cursor is older than StatusTTL.
// A watermark that does not parse is corrupt and also reconciles. A version
// mismatch is checked before validity so a stale collection id is not
// reported as a corrupt timestamp.
func decideScanReconcile(mark scanCursorWatermark, now time.Time) scanReconcileReason {
	if mark.Collection != "" && mark.Collection != goCanonicalCollectionVersion {
		return scanReconcileVersion
	}
	if !mark.valid() {
		if strings.TrimSpace(mark.Watermark) != "" {
			return scanReconcileCorrupt
		}
		return scanReconcileMissing
	}
	if mark.IncrementalRuns >= scanIncrementalReconcileEveryN() {
		return scanReconcileRunCount
	}
	anchor := mark.ReconciledAt
	if anchor == "" {
		anchor = mark.UpdatedAt
	}
	if updated, ok := parseTimestamp(&anchor); ok && now.Sub(updated) >= scanIncrementalReconcileAge() {
		return scanReconcileAge
	}
	return scanReconcileNone
}

// cursorAfterWatermark reports whether itemTime is strictly newer than the
// stored watermark. A missing watermark never matches.
func cursorAfterWatermark(itemTime, watermark string) bool {
	item, itemOK := parseTimestamp(&itemTime)
	bound, boundOK := parseTimestamp(&watermark)
	if !itemOK || !boundOK {
		return false
	}
	return item.After(bound)
}

// cursorBeforeWatermark reports whether itemTime is strictly older than the
// stored watermark. Equal timestamps are not before it: a one-second page
// can contain several ids, and the merge dedupes those ids.
func cursorBeforeWatermark(itemTime, watermark string) bool {
	item, itemOK := parseTimestamp(&itemTime)
	bound, boundOK := parseTimestamp(&watermark)
	if !itemOK || !boundOK {
		return true
	}
	return item.Before(bound)
}

func knownScanCursorSource(name string) bool {
	switch name {
	case scanCursorRepos, scanCursorExternal, scanCursorMerged:
		return true
	default:
		return false
	}
}

func encodeCursorBook(book scanCursorBook) ([]byte, error) {
	if book.Sources == nil {
		book.Sources = map[string]scanCursorWatermark{}
	}
	return json.Marshal(book)
}
